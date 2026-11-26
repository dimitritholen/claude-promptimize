import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { addEntry, type HistoryEntry, markOutcome } from '../hooks/core'
import { engine, open, PANE } from './helpers'

const NONE = '{"questions":[]}'
const ONE = '{"questions":[{"question":"Who reads it?","default":"developers"}]}'

const entry = (at: number, prompt = 'p'): HistoryEntry => ({
  at,
  prompt,
  size: 'medium',
  model: 'sonnet',
  target: 'session',
  usedContext: false,
  qa: [],
  goal: '',
  goalFix: '',
  result: `result of ${prompt}`,
  outcome: 'generated',
})

async function generated($: Engine, rough = 'write docs') {
  await open($, rough)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  return ui
}

test('addEntry puts the newest first and keeps the last 50', () => {
  const list = Array.from({ length: 50 }, (_, i) => entry(i))
  const added = addEntry(list, entry(99))
  expect(added).toHaveLength(50)
  expect(added[0]?.at).toBe(99)
  expect(added[49]?.at).toBe(48)
})

test('markOutcome changes only the entry of that moment', () => {
  const list = [entry(2), entry(1)]
  expect(markOutcome(list, 1, 'used').map(e => e.outcome)).toEqual(['generated', 'used'])
  expect(markOutcome(list, 7, 'used')).toEqual(list)
})

test('each written prompt is kept, with what led to it and not the conversation', async ($, on) => {
  const seen = engine(on, {
    replies: [ONE, NONE, '<goal>You want docs.</goal><prompt>OPTIMIZED</prompt>'],
    messages: [{ role: 'user', text: 'a private conversation' }],
  })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'context' })
  await ui.press({ key: 'generate' })
  await ui.input({ key: 'answer-1-0', text: 'managers' })

  expect(seen.history()).toHaveLength(1)
  expect(seen.history()[0]).toMatchObject({
    prompt: 'write docs',
    size: 'medium',
    model: 'sonnet',
    target: 'session',
    usedContext: true,
    qa: [{ q: 'Who reads it?', a: 'managers', source: 'answer' }],
    goal: 'You want docs.',
    result: 'OPTIMIZED',
    outcome: 'generated',
  })
  expect(typeof seen.history()[0]?.at).toBe('number')
  expect(JSON.stringify(seen.history())).not.toMatch(/private conversation/)
  await ui.unmount()
})

test('"Use" and "Copy" are recorded as what happened to the prompt', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'FIRST', 'SECOND'] })
  const ui = await generated($)
  await ui.press({ key: 'copy' })
  expect(seen.history()[0]?.outcome).toBe('copied')

  await ui.press({ key: 'regenerate' })
  expect(seen.history().map(e => [e.result, e.outcome])).toEqual([
    ['SECOND', 'generated'],
    ['FIRST', 'copied'],
  ])
  await ui.press({ key: 'use' })
  expect(seen.history()[0]?.outcome).toBe('used')
  await ui.unmount()
})

test('the history lists earlier prompts, newest first, and one opens with its result ready to use', async ($, on) => {
  const seen = engine(on, { store: { history: [entry(2000, 'second prompt'), entry(1000, 'first prompt')] } })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'history' }))?.text).toBe('History (2)')
  await ui.press({ key: 'history' })

  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('entry-'))
  expect(rows.map(r => r.key)).toEqual(['entry-2000', 'entry-1000'])
  expect(rows[0]?.text).toMatch(/medium.*second prompt/)

  await ui.press({ key: 'entry-1000' })
  expect(await ui.find({ type: 'Text', text: 'result of first prompt' })).toBeDefined()
  await ui.press({ key: 'use' })
  expect(seen.fills).toEqual([{ text: 'result of first prompt', mode: 'replace' }])
  expect(seen.history().map(e => e.outcome)).toEqual(['generated', 'used'])
  await ui.unmount()
})

test('"Back" in the history returns to the rough prompt', async ($, on) => {
  engine(on, { store: { history: [entry(1000)] } })
  await open($, 'half a thought')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'history' })
  await ui.press({ key: 'back' })
  expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('half a thought')
  await ui.unmount()
})

test('"Export" writes the history as JSON lines into the working directory', async ($, on) => {
  const seen = engine(on, { store: { history: [entry(2000, 'second prompt'), entry(1000, 'first prompt')] } })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'history' })
  await ui.press({ key: 'export' })

  expect(seen.writes).toHaveLength(1)
  // The engine hands the path on in the machine's own spelling.
  expect(seen.writes[0]?.path).toMatch(/my-repo.promptimize-history\.jsonl$/)
  const lines = (seen.writes[0]?.text ?? '').trim().split('\n').map(l => JSON.parse(l) as HistoryEntry)
  expect(lines.map(l => l.prompt)).toEqual(['first prompt', 'second prompt'])
  expect(await ui.find({ type: 'Text', text: /promptimize-history\.jsonl/ })).toBeDefined()
  await ui.unmount()
})

test('"Clear" empties the history', async ($, on) => {
  const seen = engine(on, { store: { history: [entry(1000)] } })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'history' })
  await ui.press({ key: 'clear' })

  expect(seen.history()).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'No prompts yet.' })).toBeDefined()
  await ui.unmount()
})

test('with the keepHistory option off nothing is kept and no history is offered', { options: { keepHistory: false } }, async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'] })
  await open($)
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await first.find({ key: 'history' })).toBe(undefined)
  await first.input({ key: 'prompt', text: 'write docs' })

  expect(await first.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  expect(seen.history()).toEqual([])
  await first.unmount()
})
