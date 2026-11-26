/**
 * Promptimize: /promptimize opens a pane where you type a rough prompt, pick a size
 * (small / medium / large) and optionally include the recent session context. The model
 * interviews you when the prompt leaves real gaps, then the pane shows the optimized prompt:
 * use it, regenerate it, or switch size. "Use" puts it in the prompt box, unsent.
 *
 * Options (userConfig): model, models, includeContext.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderChildren, RenderSurface } from 'claude-code'

import type { PromptimizeStage, PromptimizeUi } from '../types'
import {
  addEntry,
  askQuestions,
  countWords,
  type Complete,
  type HistoryEntry,
  markOutcome,
  modelChoices,
  type Request,
  resolveAnswer,
  rewrite,
  serializeContext,
  SIZE_SPEC,
  SIZES,
  type Size,
  type Target,
  TARGETS,
} from './core'

const PANE = 'promptimize'
// The command's name when another command or skill already holds /promptimize.
const FALLBACK_COMMAND = 'promptimize-pane'
const COMMAND = {
  description: 'Optimize a rough prompt (small / medium / large) in a pane, with a short interview first',
  argumentHint: '[rough prompt]',
}
const FALLBACK_MODEL = 'sonnet'
const ALIASES = ['opus', 'sonnet', 'haiku']

const INITIAL: PromptimizeUi = {
  stage: 'compose',
  prompt: '',
  size: 'medium',
  includeContext: null,
  model: null,
  target: 'session',
  qa: [],
  questions: [],
  qIdx: 0,
  round: 0,
  result: '',
  goal: '',
  goalFix: '',
  status: null,
  work: null,
}

// What a new run starts from; the rough prompt, size, model, target and context choice stay.
const FRESH = {
  stage: 'compose',
  qa: [],
  questions: [],
  qIdx: 0,
  round: 0,
  result: '',
  goal: '',
  goalFix: '',
  status: null,
  work: null,
} satisfies Partial<PromptimizeUi>

const OPEN = { id: PANE, title: 'Promptimize', focus: true, closeOnEscape: true, rows: 24 } as const

// Change the tag when PromptimizeUi changes: it declines what an earlier version stored.
const uiAtom = atom({ plugin: 'promptimize', key: 'ui' } as const, INITIAL, { shape: 'ui-2' })

const TONE = { info: 'subtle', warning: 'warning', error: 'error' } as const
const MARK = { info: '•', warning: '!', error: '✗' } as const
// The mark in front of a history row: what the user did with that prompt.
const OUTCOME = { generated: '·', used: '✓', copied: '+' } as const
const ACCENT = 'claude'
// Behind the options: darker than the pane in a dark theme, lighter in a light one.
const PANEL = 'inverseText'
const STEPS = ['Compose', 'Interview', 'Review'] as const
// The width of the label column in front of the controls.
const LABEL_COLUMNS = 13
const title = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// The rough prompt as typed. Kept out of $.state while the person types, so a key does not
// redraw the field under them; every write to the state carries it along.
let draft: string | undefined
let options: PluginOptions = {}
let cwd = ''
// Set while a model call runs; aborting it cancels the call.
let stop: AbortController | undefined
// The history entry of the result on screen: "Use" and "Copy" record their outcome on it.
let shownAt: number | undefined
// Whether the pane is open, as far as this module has seen: the command toggles on it.
let isOpen = false

/** Writes the state, with the typed draft folded in. */
function patch($: EngineInterface, change: Partial<PromptimizeUi>) {
  return update($, uiAtom, ui => ({ ...ui, prompt: draft ?? ui.prompt, ...change }))
}

/** The model in the session's settings, when one is set. */
async function settingsModel($: EngineInterface) {
  return text(await $.settings.read({ key: 'model' }))
}

/** The model picked in the pane, else the option, else the session's setting, else the fallback. */
async function chosenModel($: EngineInterface, ui: PromptimizeUi) {
  return ui.model ?? (text(options.model) || (await settingsModel($)) || FALLBACK_MODEL)
}

const HISTORY = 'history'
const keepsHistory = () => options.keepHistory !== false

/** The written prompts kept on this machine, newest first. */
async function history($: EngineInterface): Promise<HistoryEntry[]> {
  const kept = keepsHistory() ? await $.store.get(HISTORY) : undefined

  return Array.isArray(kept) ? (kept as HistoryEntry[]) : []
}

/** Records what the user did with the result on screen. */
async function mark($: EngineInterface, outcome: HistoryEntry['outcome']) {
  if (shownAt === undefined || !keepsHistory()) return
  await $.store.set(HISTORY, markOutcome(await history($), shownAt, outcome))
}

const wantsContext = (ui: PromptimizeUi) => ui.includeContext ?? options.includeContext === true

async function request($: EngineInterface, ui: PromptimizeUi): Promise<Request> {
  const context = wantsContext(ui) ? serializeContext(await $.session.messages()) : undefined

  return { prompt: ui.prompt, size: ui.size, qa: ui.qa, context, goal: ui.goalFix || undefined, target: ui.target }
}

/** The core's model call, through the session's own client. */
function completer($: EngineInterface, model: string): Complete {
  return async (call, signal) => {
    const reply = await $.model.complete(
      {
        model,
        system: call.system,
        prompt: call.prompt,
        maxTokens: call.cheap ? 2048 : 8192,
        ...(call.cheap ? { effort: 'low' as const } : {}),
      },
      { signal },
    )
    if (reply.isAnswered) return reply.text
    if (reply.reason === 'aborted') return null
    if (reply.reason === 'api-error') throw new Error(`API error ${reply.status ?? 'without a response'} (${reply.error})`)
    throw new Error('the model gave an empty reply')
  }
}

function tick($: EngineInterface) {
  return update($, uiAtom, ui => (ui.work ? { ...ui, work: { ...ui.work, seconds: ui.work.seconds + 1 } } : ui))
}

/** Runs one model step in the working stage. undefined when cancelled or failed: the pane is then back at `back`, its status saying which. */
async function run<T>(
  $: EngineInterface,
  label: string,
  back: PromptimizeStage,
  step: (signal: AbortSignal) => Promise<T | null>,
): Promise<T | undefined> {
  const mine = new AbortController()
  stop = mine
  await patch($, { stage: 'working', status: null, work: { label, seconds: 0, back } })
  const timer = $.clock.every(1000, () => void tick($))
  try {
    const out = await step(mine.signal)
    if (out !== null) return out
    await patch($, { stage: back, work: null, status: { tone: 'info', text: 'Cancelled.' } })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await patch($, { stage: back, work: null, status: { tone: 'error', text: `Failed: ${why}` } })
  } finally {
    timer.cancel()
    if (stop === mine) stop = undefined
  }

  return undefined
}

/** Writes the prompt. Questions still open in the round take their default. */
async function finish($: EngineInterface, back: PromptimizeStage) {
  const ui = await read($, uiAtom)
  const qa = [...ui.qa, ...ui.questions.slice(ui.qIdx).map(q => resolveAnswer(q, ''))]
  await patch($, { qa, questions: [], qIdx: 0 })
  const model = await chosenModel($, ui)
  const out = await run($, `Writing the ${ui.size} prompt`, back, async signal =>
    rewrite(completer($, model), cwd, await request($, { ...ui, qa }), signal),
  )
  if (out === undefined) return
  shownAt = undefined
  if (keepsHistory()) {
    shownAt = await $.clock.now()
    const entry: HistoryEntry = {
      at: shownAt,
      prompt: ui.prompt,
      size: ui.size,
      model,
      target: ui.target,
      usedContext: wantsContext(ui),
      qa,
      goal: out.goal,
      goalFix: ui.goalFix,
      result: out.prompt,
      outcome: 'generated',
    }
    await $.store.set(HISTORY, addEntry(await history($), entry))
  }
  await patch($, { stage: 'result', result: out.prompt, goal: out.goal, work: null })
}

/** Asks the next interview round, or writes the prompt when the budget is spent or the model has enough. */
async function nextRound($: EngineInterface, back: PromptimizeStage) {
  const ui = await read($, uiAtom)
  if (ui.round >= SIZE_SPEC[ui.size].rounds) return finish($, back)
  const model = await chosenModel($, ui)
  const res = await run($, 'Checking what to ask', back, async signal =>
    askQuestions(completer($, model), cwd, await request($, ui), ui.round + 1, signal),
  )
  if (!res) return
  if (res.unreadable) $.ui.toast('promptimize: the interview reply was unreadable, so it was skipped.')
  if (!res.questions.length) return finish($, back)
  await patch($, { stage: 'interview', questions: res.questions, qIdx: 0, round: ui.round + 1, work: null })
}

async function start($: EngineInterface, typed?: string) {
  if (stop) return
  if (typed !== undefined) draft = typed
  const ui = await read($, uiAtom)
  if (!(draft ?? ui.prompt).trim()) {
    await patch($, { status: { tone: 'warning', text: 'Type a prompt first.' } })

    return
  }
  draft = (draft ?? ui.prompt).trim()
  await patch($, { qa: [], questions: [], qIdx: 0, round: 0, goalFix: '', status: null })
  await nextRound($, 'compose')
}

async function answer($: EngineInterface, typed: string) {
  const ui = await read($, uiAtom)
  const question = ui.questions[ui.qIdx]
  if (!question) return
  await patch($, { qa: [...ui.qa, resolveAnswer(question, typed)], qIdx: ui.qIdx + 1 })
  if (ui.qIdx + 1 >= ui.questions.length) await nextRound($, 'interview')
}

/** The user says what they are really after; the rewrite runs again with that as its starting point. */
async function correct($: EngineInterface, typed: string) {
  if (!typed.trim()) return
  await patch($, { goalFix: typed.trim(), status: null })
  await finish($, 'result')
}

/** Another size keeps the interview answers; only the rewrite runs again. */
async function resize($: EngineInterface, size: Size) {
  await patch($, { size, status: null })
  await finish($, 'result')
}

async function copy($: EngineInterface, surface: RenderSurface) {
  const ui = await read($, uiAtom)
  const copied = await $.ui.copy({ text: ui.result, surface })
  if (copied.isCopied) await mark($, 'copied')
  await patch($, {
    status: copied.isCopied
      ? { tone: 'info', text: 'Copied to the clipboard.' }
      : { tone: 'error', text: 'The clipboard is not available here.' },
  })
}

/** Puts the result in the prompt box, unsent. The pane closes first, so the box can take the text. */
async function use($: EngineInterface, surface: RenderSurface) {
  const ui = await read($, uiAtom)
  isOpen = false
  await $.ui.close({ id: PANE })
  let note = 'Optimized prompt is in the prompt box. Edit or send it.'
  const filled = await $.prompt.fill({ text: ui.result, mode: 'replace' })
  if (!filled.isFilled) {
    const copied = await $.ui.copy({ text: ui.result, surface })
    if (!copied.isCopied) {
      await patch($, { status: { tone: 'error', text: 'The prompt could not be placed in the prompt box or on the clipboard.' } })
      isOpen = (await $.ui.open(OPEN)).isPlaced

      return
    }
    note = 'The prompt box did not take the text, so it is on the clipboard.'
  }
  await mark($, filled.isFilled ? 'used' : 'copied')
  draft = '' // a used prompt starts fresh next time
  await patch($, FRESH)
  $.ui.toast(note)
}

/** Opens an earlier prompt from the history as the result on screen. */
async function showEntry($: EngineInterface, at: number) {
  const entry = (await history($)).find(one => one.at === at)
  if (!entry) return
  draft = entry.prompt
  shownAt = at
  await patch($, { stage: 'result', size: entry.size, model: entry.model, target: entry.target, qa: entry.qa, result: entry.result, goal: entry.goal, goalFix: '', status: null })
}

/** Writes the history, oldest first, as JSON lines into the working directory. */
async function exportHistory($: EngineInterface) {
  const list = (await history($)).reverse()
  const path = `${cwd.replace(/[\\/]+$/, '')}/promptimize-history.jsonl`
  try {
    await $.fs.write(path, `${list.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    await patch($, { status: { tone: 'info', text: `Wrote ${list.length} prompts to ${path}` } })
  } catch (err) {
    await patch($, { status: { tone: 'error', text: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}` } })
  }
}

async function clearHistory($: EngineInterface) {
  await $.store.set(HISTORY, [])
  await patch($, { status: { tone: 'info', text: 'History cleared.' } })
}

/** The command: opens the pane on a new run, with `args` as the rough prompt when given; with no `args` on an open pane, closes it. */
async function togglePane($: EngineInterface, args: string | undefined) {
  const typed = text(args)
  if (isOpen && !typed) {
    isOpen = false
    stop?.abort()
    await $.ui.close({ id: PANE })

    return {}
  }
  if (typed) draft = typed
  if (!stop) await patch($, FRESH)
  const opened = await $.ui.open(OPEN)
  isOpen = opened.isPlaced
  if (!opened.isPlaced) return { text: `promptimize could not open a pane here: ${opened.reason}` }

  return {}
}

export const register: Register = (on, given) => {
  options = given

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      await $.command.register({ name: PANE, ...COMMAND })
    } catch {
      // Another command or skill holds /promptimize.
      await $.command.register({ name: FALLBACK_COMMAND, ...COMMAND })
    }

    return next(e)
  })

  on('command.run', { command: PANE }, ($, e) => togglePane($, e.args))
  on('command.run', { command: FALLBACK_COMMAND }, ($, e) => togglePane($, e.args))

  // Closing the pane (Esc included) cancels a running call.
  on('ui.close', { id: PANE }, ($, e, next) => {
    isOpen = false
    stop?.abort()

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Progress, Select, Text } = $.ui.resolve(e)
    const ui = await read($, uiAtom)
    // A docked pane can be as narrow as 24 columns: there the header stacks and the labels sit above their fields.
    const isWide = e.props.bodyColumns >= 56

    // The step the "New prompt" page is on. A model call belongs to the step it leads to.
    const step = ui.stage === 'compose' ? 0 : ui.stage === 'result' || ui.work?.back === 'result' ? 2 : 1
    const steps = (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        {STEPS.map((name, i) =>
          i === step ? <Text bold color={ACCENT}>{`● ${name}`}</Text> : <Text dimColor>{`${i < step ? '✓' : '○'} ${name}`}</Text>,
        )}
      </Box>
    )
    const isHistory = ui.stage === 'history'
    /** One tab: a frame around its name, in the accent color while its page shows. */
    const tab = (box: string, isActive: boolean, button: RenderChildren) => (
      <Box key={box} borderStyle="round" borderColor={isActive ? ACCENT : 'subtle'} paddingX={1}>
        {button}
      </Box>
    )
    // The title and the tabs stay on top of every page; only what is beneath them changes.
    const header = (
      <Box flexDirection="column">
        <Text bold color={ACCENT}>◆ Promptimize</Text>
        <Box flexDirection="row" columnGap={1}>
          {tab(
            'tabbox-new',
            !isHistory,
            <Button key="tab-new" plain dimColor={isHistory} label="New prompt" onPress={() => void (isHistory && patch($, { stage: 'compose', status: null }))} />,
          )}
          {keepsHistory() &&
            tab(
              'tabbox-history',
              isHistory,
              <Button
                key="history"
                plain
                dimColor={!isHistory}
                label={`History (${(await history($)).length})`}
                onPress={() => void (!isHistory && !stop && patch($, { stage: 'history', status: null }))}
              />,
            )}
        </Box>
      </Box>
    )
    const status = ui.status && (
      <Box flexDirection="row" gap={1}>
        <Text color={TONE[ui.status.tone]}>{MARK[ui.status.tone]}</Text>
        <Text color={TONE[ui.status.tone]}>{ui.status.text}</Text>
      </Box>
    )
    /** The key hints under a page: each key in bold, what it does beside it. They wrap as whole hints. */
    const hints = (...pairs: [key: string, does: string][]) => (
      <Box flexDirection="row" columnGap={3} flexWrap="wrap">
        {pairs.map(([key, does]) => (
          <Text dimColor>
            <Text bold>{key}</Text>
            {` ${does}`}
          </Text>
        ))}
      </Box>
    )
    /** A framed block with a caption on its first row. */
    const card = (caption: string, color: 'subtle' | typeof ACCENT | 'success', ...body: RenderChildren[]) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text dimColor>{caption}</Text>
        {body}
      </Box>
    )
    /** A labelled control, the labels of a stage lined up in one column. */
    const field = (label: string, control: RenderChildren) => (
      <Box flexDirection={isWide ? 'row' : 'column'}>
        <Box width={LABEL_COLUMNS}>
          <Text dimColor>{label}</Text>
        </Box>
        {control}
      </Box>
    )

    if (ui.stage === 'working' && ui.work) {
      return (
        <Box flexDirection="column" gap={1} paddingRight={2}>
          {header}
          {steps}
          {card(`${ui.work.seconds}s`, ACCENT, <Progress label={`${ui.work.label}…`} />)}
          <Button key="cancel" autoFocus label="Cancel" onPress={() => stop?.abort()} />
          {hints(['Enter', 'cancel'], ['Esc', 'cancel and close'])}
        </Box>
      )
    }

    if (ui.stage === 'result') {
      const words = countWords(ui.result)

      // The actions come first: a long prompt scrolls beneath them.
      return (
        <Box flexDirection="column" gap={1} paddingRight={2}>
          {header}
          {steps}
          <Box flexDirection="column">
            {field(
              'Actions',
              <Box flexDirection="row" gap={2}>
                <Button key="use" variant="primary" autoFocus label="Use" onPress={press => void use($, press.surface)} />
                <Button key="regenerate" plain hotkey="r" label="Regenerate" onPress={() => void finish($, 'result')} />
                <Button key="edit" plain hotkey="e" label="Edit prompt" onPress={() => void patch($, { stage: 'compose', status: null })} />
                <Button key="copy" plain hotkey="c" label="Copy" onPress={press => void copy($, press.surface)} />
              </Box>,
            )}
            {field(
              'Size',
              <Box flexDirection="row" gap={2}>
                {SIZES.map((size: Size, i) => (
                  <Button
                    key={`size-${size}`}
                    plain
                    hotkey={String(i + 1)}
                    dimColor={size !== ui.size}
                    label={title(size)}
                    onPress={() => void resize($, size)}
                  />
                ))}
              </Box>,
            )}
          </Box>
          {status}
          {card(
            ui.goal ? 'What I think you are after' : 'Not what you meant?',
            'subtle',
            ui.goal && <Text>{ui.goal}</Text>,
            <Input
              key="goal"
              placeholder={ui.goal ? 'Not quite? Say what you are after' : 'Say what you are after'}
              submitLabel="rewrite"
              onSubmit={value => void correct($, value)}
            />,
          )}
          {card(`Optimized prompt · ${ui.size} · ${words} ${words === 1 ? 'word' : 'words'}`, 'success', <Text>{ui.result}</Text>)}
          {hints(['Enter', 'use, unsent'], ['r', 'regenerate'], ['1-3', 'size'], ['e', 'edit'], ['c', 'copy'], ['Esc', 'close'])}
        </Box>
      )
    }

    if (ui.stage === 'history') {
      const list = await history($)
      const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

      return (
        <Box flexDirection="column" gap={1} paddingRight={2}>
          {header}
          <Box flexDirection="row" gap={2}>
            <Button key="export" label="Export" onPress={() => void exportHistory($)} />
            <Button key="clear" label="Clear" onPress={() => void clearHistory($)} />
          </Box>
          {status}
          {card(
            `${list.length} ${list.length === 1 ? 'prompt' : 'prompts'}, newest first · times in UTC`,
            'subtle',
            list.length === 0 && <Text dimColor>No prompts yet.</Text>,
            list.map((entry, i) => (
              <Button
                key={`entry-${entry.at}`}
                plain
                {...(i === 0 ? { autoFocus: true as const } : {})}
                dimColor={entry.outcome === 'generated'}
                label={`${OUTCOME[entry.outcome]} ${stamp(entry.at)}  ${entry.size.padEnd(6)}  ${entry.prompt.replace(/\s+/g, ' ').slice(0, 60)}`}
                onPress={() => void showEntry($, entry.at)}
              />
            )),
          )}
          {hints(['Enter', 'open'], ['✓', 'used'], ['+', 'copied'], ['Esc', 'close'])}
        </Box>
      )
    }

    if (ui.stage === 'interview') {
      const question = ui.questions[ui.qIdx]
      const answered = ui.qIdx ? ui.qa.slice(-ui.qIdx) : []

      return (
        <Box flexDirection="column" gap={1} paddingRight={2}>
          {header}
          {steps}
          <Text dimColor>{`“${ui.prompt.split('\n')[0] ?? ''}” · ${ui.size}`}</Text>
          {answered.map(x => (
            <Box flexDirection="column">
              <Text dimColor>{`Q: ${x.q}`}</Text>
              <Text>
                {`A: ${x.source === 'skipped' ? '(skipped)' : x.a}${x.source === 'default' ? ' (default)' : ''}`}
              </Text>
            </Box>
          ))}
          {question &&
            card(
              `Round ${ui.round}/${SIZE_SPEC[ui.size].rounds} · question ${ui.qIdx + 1}/${ui.questions.length}`,
              ACCENT,
              <Text bold>{question.question}</Text>,
              question.default && <Text dimColor>{`Default: ${question.default}`}</Text>,
              <Input
                key={`answer-${ui.round}-${ui.qIdx}`}
                autoFocus
                rows={2}
                placeholder="Your answer"
                submitLabel="answer"
                onSubmit={value => void answer($, value)}
              />,
            )}
          {status}
          <Box flexDirection="row" gap={2}>
            {!question && (
              <Button key="retry" variant="primary" autoFocus label="Retry" onPress={() => void nextRound($, 'interview')} />
            )}
            <Button key="defaults" label="Use defaults and generate" onPress={() => void finish($, 'interview')} />
          </Box>
          {hints(['Enter', 'answer'], ['empty', 'take the default'], ['-', 'skip'], ['Esc', 'close'])}
        </Box>
      )
    }

    const configured = await settingsModel($)
    const model = await chosenModel($, ui)
    const includeContext = wantsContext(ui)
    const choices = modelChoices(text(options.model), configured, text(options.models), ...ALIASES, model)

    return (
      <Box flexDirection="column" gap={1} paddingRight={2}>
        {header}
        {steps}
        {card(
          'Your rough prompt',
          ACCENT,
          <Input
            key="prompt"
            rows={5}
            autoFocus
            value={ui.prompt}
            placeholder="What do you want done?"
            submitLabel="generate"
            onInput={value => {
              draft = value
            }}
            onSubmit={value => void start($, value)}
          />,
        )}
        <Box key="options" flexDirection="column" backgroundColor={PANEL} paddingX={2} paddingY={1}>
          {field(
            'Size',
            <Box flexDirection="row" gap={2}>
              {SIZES.map((size: Size) => (
                <Button
                  key={`size-${size}`}
                  plain
                  dimColor={size !== ui.size}
                  label={`${size === ui.size ? '●' : '○'} ${title(size)}`}
                  onPress={() => void patch($, { size })}
                />
              ))}
            </Box>,
          )}
          {field(
            'Context',
            <Button
              key="context"
              plain
              dimColor={!includeContext}
              label={`${includeContext ? '[✓]' : '[ ]'} Include recent session context`}
              onPress={() => void patch($, { includeContext: !includeContext })}
            />,
          )}
          {field(
            'Written by',
            <Select key="model" options={choices.map(value => ({ value }))} value={model} onSelect={value => void patch($, { model: value })} />,
          )}
          {field(
            'Written for',
            <Select
              key="target"
              options={Object.entries(TARGETS).map(([value, label]) => ({ value, label }))}
              value={ui.target}
              onSelect={value => void patch($, { target: value as Target })}
            />,
          )}
        </Box>
        <Button key="generate" variant="primary" label="Generate" onPress={() => void start($)} />
        {status}
        {hints(['Tab', 'next field'], ['Enter', 'generate'], ['Esc', 'close'])}
      </Box>
    )
  })
}
