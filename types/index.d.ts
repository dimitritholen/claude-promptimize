export type PromptimizeStage = 'compose' | 'working' | 'interview' | 'result'

/** Everything the pane draws from, kept for the session. */
export type PromptimizeUi = {
  stage: PromptimizeStage
  /** The rough prompt. */
  prompt: string
  size: 'small' | 'medium' | 'large'
  /** null: the `includeContext` option decides. */
  includeContext: boolean | null
  /** null: the default model. */
  model: string | null
  /** Who the optimized prompt is written for. */
  target: 'session' | 'claude' | 'gpt' | 'gemini' | 'image'
  qa: { q: string; a: string; source: 'answer' | 'default' | 'skipped' }[]
  /** The questions of the round in progress. */
  questions: { question: string; default?: string }[]
  qIdx: number
  round: number
  result: string
  /** The model's reading of what the user is after, shown beside the result. */
  goal: string
  /** The user's correction of that reading; the next rewrite starts from it. */
  goalFix: string
  status: { tone: 'info' | 'warning' | 'error'; text: string } | null
  /** Set while a model call runs; `back` is the stage a cancel or failure returns to. */
  work: { label: string; seconds: number; back: PromptimizeStage } | null
}

declare module 'claude-code' {
  interface PluginState {
    promptimize: { ui: Shaped<PromptimizeUi> }
  }
}
