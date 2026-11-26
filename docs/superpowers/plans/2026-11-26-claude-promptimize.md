# Claude Promptimize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the pi extension `pi-promptimize` to a Claude Code mod: `/promptimize` opens a pane where you type a rough prompt, pick a size, answer a short interview and get an optimized prompt placed in the prompt box.

**Architecture:** One Claude Code plugin with a hooks module (a "mod"). `hooks/core.ts` holds the prompts, parsing and interview logic, free of any engine or Node import. `hooks/register.tsx` registers the command, draws the pane for four stages (compose, working, interview, result) from one `$.state` value, and calls the model through `$.model.complete`.

**Tech Stack:** TypeScript (ES module, JSX with factory `h`), Claude Code mod API 2.1.332, `claude plugin test` (kit `claude-code/testing`), `claude plugin validate`, `tsc` for static analysis, Node 26 for the eval script only.

**Spec:** The pi extension is the spec: `C:\projects\pi-promptimize\README.md`, `extensions/promptimize/core.ts`, `extensions/promptimize/index.ts`, `test/core.test.ts`, `eval/run.ts`.

## Global Constraints

- Project root: `C:\projects\claude-promptimize`. Plugin name: `promptimize`. Command: `/promptimize [text]`. Pane id: `promptimize`.
- The hooks module and everything it imports has no Node and no DOM. `core.ts` must not import `node:path`.
- `INTERVIEW_PROMPT`, `REWRITE_PROMPT`, `SIZE_SPEC` and the input builders are copied verbatim from the pi `core.ts`. One change: the target sentence says `a coding agent (Claude Code)` instead of `a coding agent (pi)`.
- Sizes and budgets unchanged: small 2 questions in 1 round, medium 3 in 2, large 4 in 3.
- Context cap unchanged: last 10 messages, 16 000 characters, older text cut from the front with a leading `…`.
- Model calls: interview `effort: "low"`, `maxTokens: 2048`. Rewrite: no `effort` (the model's own), `maxTokens: 8192`.
- The mod never sends the prompt. "Use" calls `$.prompt.fill({ text, mode: "replace" })`.
- No commits: the user commits.
- Found while building: when another command or skill holds `/promptimize` the engine refuses the registration, so the mod then registers `/promptimize-pane`. Where no pane can open, the command answers `promptimize could not open a pane here: <reason>`.
- Found while building: the test kit cannot raise `ui.close`, so the abort-on-close hook has no test.
- Checks before done: `claude plugin test .`, `claude plugin validate .` (`--strict` fails only on the missing icon), `tsc` with the types file of this build.

## What the port changes, and why

| pi | Claude Code mod | Reason |
|---|---|---|
| Centered overlay popup | Pane opened with `focus`, `closeOnEscape`, `rows: 24` | The API has panes, no modal. |
| `ctx.ui.setEditorText` | `$.prompt.fill`, fallback `$.ui.copy` when the box refuses | Same result. |
| Model registry, fuzzy picker | `Select` over: user setting, session setting `model`, `models` option, `opus`, `sonnet`, `haiku` | No model registry in the API, no free-text filter in `Select`. |
| Default model = session model | `userConfig.model`, else setting `model`, else `sonnet` | The API does not expose the session's resolved model. |
| Session thinking level, retry without reasoning | Fixed effort per call; no retry | The engine drops `effort` on models without it. |
| Tab = next field / "defaults and generate" | Tab and arrows walk the focus ring; a button "Use defaults and generate" | Focus keys are the engine's. |
| Keys `r`, `e`, `1-3` in review | Button `hotkey`s `r`, `e`, `c`, `1`, `2`, `3`, in the result stage only | Hotkeys work while the pane holds focus; in a stage with a text field they would collide with typing. |
| Esc cancels a running call, else closes | Esc closes the pane and aborts a running call; a Cancel button aborts only | `closeOnEscape` is the engine's. |
| `alt+p` registered by the extension | README: bind `command:promptimize` in `~/.claude/keybindings.json` | A mod cannot register a chord. |
| Spinner frames | `Progress` (indeterminate) plus elapsed seconds from `$.clock.every` | Engine element. |
| Remembers model, size, context, draft until restart | Same, in `$.state` (session) | Same. |
| Eval through pi's model registry | Eval through `claude -p` | Runs outside the engine. |

## File Structure

- `.claude-plugin/plugin.json`: manifest, `types`, `userConfig` (`model`, `models`, `includeContext`).
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`.
- `hooks/core.ts`: prompts, input builders, parsing, `serializeContext`, `modelChoices`, `askQuestions`, `rewrite`. Pure.
- `hooks/register.tsx`: command, pane, flow, model adapter.
- `types/index.d.ts`: `PluginState` contract.
- `tests/core.test.ts`, `tests/pane.test.tsx`.
- `eval/run.ts`, `eval/cases.json`: real-model eval through `claude -p`.
- `README.md`, `LICENSE`, `.gitignore`, `package.json` (scripts only, no dependencies).

## Review Focus

1. The interview reply is not JSON: the interview is skipped with a notice and the rewrite still runs. Test in Task 3.
2. The model call fails (`api-error`) or the engine rejects the model id: the pane shows `Failed: …` and stays usable. Test in Task 3.
3. The prompt box refuses the fill (a dialog is open): the text goes to the clipboard and a toast says so. Test in Task 4.
4. Empty rough prompt: `Type a prompt first.`, no model call. Test in Task 3.
5. A state value stored by older code after a hot reload: read as the initial value through the `shape` tag. Test in Task 2.

---

### Task 1: Core

**Files:**
- Create: `hooks/core.ts`, `tests/core.test.ts`, `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx` (empty `register`), `package.json`, `.gitignore`

**Interfaces (produces):**

```ts
export const SIZES: readonly ["small", "medium", "large"]
export type Size = (typeof SIZES)[number]
export const SIZE_SPEC: Record<Size, { rules: string; questions: number; rounds: number; example: string }>
export type QA = { q: string; a: string; source: "answer" | "default" | "skipped" }
export type Question = { question: string; default?: string }
export type Request = { prompt: string; size: Size; qa: QA[]; context?: string }
/** One model call. Resolves the reply text, or null when aborted. Throws on failure. */
export type Complete = (call: { system: string; prompt: string; cheap: boolean }, signal: AbortSignal) => Promise<string | null>
export function folderName(cwd: string): string            // last path segment, / or \
export function interviewInput(cwd: string, req: Request, round: number): string
export function rewriteInput(cwd: string, req: Request): string
export function resolveAnswer(q: Question, text: string): QA
export function parseQuestions(reply: string, max: number): Question[] | null
export function stripFence(text: string): string
export function avgSentenceWords(text: string): number
export function serializeContext(messages: readonly { role: string; text: string }[]): string | undefined
export function modelChoices(...ids: (string | undefined)[]): string[]   // trimmed, comma lists split, unique, order kept
export function askQuestions(complete: Complete, cwd: string, req: Request, round: number, signal: AbortSignal): Promise<{ questions: Question[]; unreadable: boolean } | null>
export function rewrite(complete: Complete, cwd: string, req: Request, signal: AbortSignal): Promise<string | null>
```

- [ ] **Step 1:** Write the scaffold files (manifest without `userConfig` yet, empty `register`).
- [ ] **Step 2:** Write `tests/core.test.ts`: the pi tests ported to `claude-code/testing` (`parseQuestions`, `resolveAnswer`, input builders, `stripFence`, `avgSentenceWords`, `rewrite` strips a fence). Drop the `reasoningFor` and retry tests. Add:
  - `folderName("C:\\x\\my-repo") === "my-repo"`, `folderName("/x/my-repo/") === "my-repo"`.
  - `serializeContext([])` is `undefined`; two messages give `"User: a\n\nAssistant: b"`; messages with empty text are left out; more than 10 keeps the last 10; over 16 000 characters gives a string of 16 001 starting with `…`.
  - `modelChoices(" a ", undefined, "b, a ,c", "") ` equals `["a", "b", "c"]`.
  - `askQuestions` passes `cheap: true` and the interview system prompt; an unreadable reply gives `{ questions: [], unreadable: true }`; a `null` reply gives `null`.
- [ ] **Step 3:** Run `claude plugin test .`. Expected: FAIL, `core.ts` not found.
- [ ] **Step 4:** Write `hooks/core.ts`.
- [ ] **Step 5:** Run `claude plugin test .`. Expected: PASS.

### Task 2: Command, state and the compose stage

**Files:**
- Create: `types/index.d.ts`, `tests/pane.test.tsx`
- Modify: `hooks/register.tsx`, `.claude-plugin/plugin.json` (add `types`, `userConfig`)

**Interfaces (produces):**

```ts
// types/index.d.ts
export type PromptimizeStage = "compose" | "working" | "interview" | "result"
export type PromptimizeUi = {
  stage: PromptimizeStage
  prompt: string            // the rough prompt
  size: "small" | "medium" | "large"
  includeContext: boolean | null   // null: take the option's default
  model: string | null             // null: take the default model
  qa: { q: string; a: string; source: "answer" | "default" | "skipped" }[]
  questions: { question: string; default?: string }[]
  qIdx: number
  round: number
  result: string
  status: { tone: "info" | "warning" | "error"; text: string } | null
  work: { label: string; seconds: number; back: PromptimizeStage } | null
}
// PluginState: promptimize: { ui: Shaped<PromptimizeUi> }   shape tag "ui-1"
```

`userConfig`: `model` (string, default `""`), `models` (string, default `""`, comma-separated extra ids), `includeContext` (boolean, default `false`).

Element keys in the compose stage: `model` (Select), `prompt` (Input, `rows: 5`, `autoFocus`), `size-small` / `size-medium` / `size-large` (Buttons, label `(•) Small` or `( ) Small`), `context` (Button, label `[x] Include recent session context` or `[ ] …`), `generate` (Button, primary). Status line: a `Text` with the status text.

- [ ] **Step 1:** Write failing tests in `tests/pane.test.tsx`:
  - `/promptimize fix the bug` calls `ui.open` with `{ id: "promptimize", focus: true, closeOnEscape: true }` and the pane's `prompt` Input shows `fix the bug`.
  - Pressing `size-large` makes that button read `(•) Large`; pressing `context` toggles `[x]`.
  - With option `model: "opus"` the Select's value is `opus`; with no option and setting `model: "fable-x"` it is `fable-x`; with neither it is `sonnet`.
  - With option `includeContext: true` the box starts ticked.
  - A stored value without the shape tag is read as the initial state (Review Focus 5).
  - A non-interactive session (`surface: null`) answers `promptimize needs interactive mode` and opens nothing.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement: `session.start` (register the command, keep `cwd`), `command.run`, `ui.render` for the compose stage, the state atom, the draft kept in a module variable and folded into state by every write.
- [ ] **Step 4:** Run. Expected: PASS.

### Task 3: Generate, interview, working

**Files:** Modify `hooks/register.tsx`, `tests/pane.test.tsx`

Element keys: working stage `cancel`; interview stage `answer` (Input, `autoFocus`; the key carries round and index: `answer-<round>-<qIdx>`), `defaults` (Button "Use defaults and generate"), `retry` (Button, only when no question is pending).

Model adapter: `$.model.complete({ model, system, prompt, effort?, maxTokens }, { signal })`. `aborted` gives `null`; `api-error` throws `API error <status> (<error>)`; `empty-reply` throws `the model gave an empty reply`; a rejection is thrown on.

- [ ] **Step 1:** Write failing tests:
  - Generate with an interview reply `{"questions":[]}`: two model calls (interview with `effort: "low"`, then rewrite), the chosen model on both, and the result text shown.
  - Interview reply with two questions: the first question and `Default: …` are shown; submitting an empty answer, then `managers`, runs the next round; the rewrite prompt holds `(default, accepted by the user)` and `A: managers`.
  - `defaults` on the first question gives every open question its default and runs the rewrite without another interview call.
  - Size medium allows a second round: after round 1 the interview is called again with `round 2 of 2`.
  - Unreadable interview reply: a toast holds `unreadable`, the rewrite runs (Review Focus 1).
  - `api-error` on the rewrite: status `Failed: API error 529 (overloaded)`, stage back to compose (Review Focus 2).
  - `aborted`: status `Cancelled.`.
  - Empty prompt: status `Type a prompt first.`, no model call (Review Focus 4).
  - Context ticked: `session.messages` is read and the rewrite prompt holds `<session_context>`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `start`, `nextRound`, `finish`, `run` (work label, elapsed seconds, abort controller), the interview and working drawings, and the `ui.close` hook that aborts a running call and keeps the draft.
- [ ] **Step 4:** Run. Expected: PASS.

### Task 4: Result stage

**Files:** Modify `hooks/register.tsx`, `tests/pane.test.tsx`

Element keys: `use` (primary, `autoFocus`), `regenerate` (hotkey `r`), `edit` (hotkey `e`), `copy` (hotkey `c`), `size-small|medium|large` (hotkeys `1`, `2`, `3`).

- [ ] **Step 1:** Write failing tests:
  - `use` calls `prompt.fill` with the result and `mode: "replace"`, closes the pane, and the next open starts with an empty prompt.
  - `prompt.fill` answering `isFilled: false`: `ui.copy` gets the text and a toast says it is on the clipboard (Review Focus 3).
  - `size-small` in the result stage makes one more model call (rewrite only), with `SIZE: SMALL` and the earlier answers.
  - `regenerate` makes one more rewrite call.
  - `edit` goes back to compose with the rough prompt in the field.
  - `copy` calls `ui.copy` with the result and keeps the pane open.
  - Closing without "Use" keeps the draft: the next open shows it.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the result drawing and its handlers.
- [ ] **Step 4:** Run. Expected: PASS.

### Task 5: Static checks, eval, docs

**Files:** Create `eval/run.ts`, `eval/cases.json` (copy), `README.md`, `LICENSE` (copy)

- [ ] **Step 1:** `claude plugin validate . --strict`. Expected: no errors.
- [ ] **Step 2:** `tsc` with a tsconfig kept outside the project that includes this build's `claude-code.d.ts`, `hooks`, `types`, `tests`. Expected: no errors.
- [ ] **Step 3:** Port `eval/run.ts`: same cases, checks and options (`--model`, `--sizes`, `--cases`, `--concurrency`; `--thinking` is dropped). The `Complete` adapter runs `claude -p --model <m> --system-prompt-file <tmp> --tools "" --no-session-persistence --output-format json` with the prompt on stdin, `--effort low` for a cheap call, and reads `result`.
- [ ] **Step 4:** Smoke run: `node eval/run.ts --cases <one id> --sizes small`. Expected: a table with one row.
- [ ] **Step 5:** Write `README.md`: install, use, keys, settings, the keybinding line, differences from the pi version, test and eval commands.
- [ ] **Step 6:** Run all checks again. Expected: PASS.
