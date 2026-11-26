import type { ModelApiError, ModelCompleteResult, On, UiCopyResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

export const PANE = {
  plugin: 'promptimize',
  component: 'Pane',
  requestId: 'promptimize',
  props: {
    title: 'Promptimize',
    isFocused: true,
    bodyColumns: 70,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A model reply in the queue: text, or one of the ways a call ends without text. */
export type Reply = string | { aborted: true } | { status: number; error: string }

export type Setup = {
  settings?: Record<string, unknown>
  replies?: Reply[]
  isPlaced?: boolean
  isFilled?: boolean
  isCopied?: boolean
  /** Another command already holds the name /promptimize. */
  isNameTaken?: boolean
  /** The engine refuses every model call with this reason. */
  deny?: string
  messages?: { role: 'user' | 'assistant'; text: string }[]
}

/** Stands for the engine beneath the mod and records what the mod asked of it. */
export function engine(on: On, setup: Setup = {}) {
  const replies = [...(setup.replies ?? [])]
  const seen = {
    opens: [] as Record<string, unknown>[],
    closes: 0,
    fills: [] as { text: string; mode?: string }[],
    copies: [] as string[],
    toasts: [] as string[],
    calls: [] as { model: string; system?: string; prompt: string; effort?: string; maxTokens?: number }[],
    messageReads: 0,
    registered: [] as string[],
  }
  mock.clock(on)
  on('command.register', (_, e) => {
    seen.registered.push(e.name)
    if (setup.isNameTaken && e.name === 'promptimize') return { deny: '"/promptimize" refused: another command holds it' }

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: setup.settings ?? {} }))
  on('ui.open', (_, e) => {
    seen.opens.push({ ...e })

    return { value: setup.isPlaced === false ? { isPlaced: false, reason: 'no surface' } : { isPlaced: true } }
  })
  on('ui.close', () => {
    seen.closes++

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    seen.copies.push(e.text)
    const value: UiCopyResult =
      setup.isCopied === false ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: true }

    return { value }
  })
  on('prompt.fill', (_, e) => {
    seen.fills.push({ text: e.text, mode: e.mode })
    const isFilled = setup.isFilled !== false

    return isFilled
      ? { isFilled, text: e.text, cursor: e.text.length }
      : { isFilled, refusal: 'dialog', text: '', cursor: 0 }
  })
  on('session.messages', () => {
    seen.messageReads++

    return { value: (setup.messages ?? []).map(m => ({ ...m, toolUses: [] })) }
  })
  on('model.complete', (_, e) => {
    if (setup.deny) return { deny: setup.deny }
    seen.calls.push({ model: e.model, system: e.system, prompt: e.prompt, effort: e.effort, maxTokens: e.maxTokens })
    const reply = replies.shift() ?? ''
    const value: ModelCompleteResult =
      typeof reply === 'string'
        ? { isAnswered: true, text: reply, usage: USAGE }
        : 'aborted' in reply
          ? { isAnswered: false, reason: 'aborted', usage: USAGE }
          : { isAnswered: false, reason: 'api-error', status: reply.status, error: reply.error as ModelApiError, usage: USAGE }

    return { value }
  })

  return seen
}

/** Starts a session in a terminal and types `/promptimize <args>`. */
export async function open($: Engine, args = '', command = 'promptimize') {
  await $.session.start({ cwd: '/x/my-repo', surface: 'terminal', isInteractive: true })

  return $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}
