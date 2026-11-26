import { expect, test } from 'claude-code/testing'

import { engine, open, PANE } from './helpers'

const NONE = '{"questions":[]}'
const TWO = '{"questions":[{"question":"Who reads it?","default":"developers"},{"question":"Which tone?","default":"neutral"}]}'

test('generate asks the interview, then writes the prompt with the chosen model', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.select({ key: 'model', value: 'haiku' })
  await ui.press({ key: 'generate' })

  expect(seen.calls).toHaveLength(2)
  expect(seen.calls[0]).toMatchObject({ model: 'haiku', effort: 'low', maxTokens: 2048 })
  expect(seen.calls[0]?.system).toMatch(/interview the user/)
  expect(seen.calls[0]?.prompt).toMatch(/"my-repo"/)
  expect(seen.calls[1]).toMatchObject({ model: 'haiku', maxTokens: 8192 })
  expect(seen.calls[1]?.effort).toBe(undefined)
  expect(seen.calls[1]?.prompt).toMatch(/SIZE: MEDIUM/)
  expect(seen.calls[1]?.prompt).toMatch(/<rough_prompt>\nwrite docs\n<\/rough_prompt>/)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  await ui.unmount()
})

test('Enter in the prompt field generates with what was typed', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'] })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'prompt', text: 'fix the login bug' })

  expect(seen.calls[1]?.prompt).toMatch(/<rough_prompt>\nfix the login bug\n<\/rough_prompt>/)
  await ui.unmount()
})

test('the interview takes a default for an empty answer and carries the answers to the rewrite', async ($, on) => {
  const seen = engine(on, { replies: [TWO, 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'size-small' })
  await ui.press({ key: 'generate' })

  expect(await ui.find({ type: 'Text', text: /Round 1\/1 · question 1\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Who reads it?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Default: developers' })).toBeDefined()
  await ui.input({ key: 'answer-1-0', text: '' })
  expect(await ui.find({ type: 'Text', text: 'A: developers (default)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which tone?' })).toBeDefined()
  await ui.input({ key: 'answer-1-1', text: 'formal' })

  expect(seen.calls).toHaveLength(2)
  expect(seen.calls[1]?.prompt).toMatch(/Q: Who reads it\?\nA: developers \(default, accepted by the user\)/)
  expect(seen.calls[1]?.prompt).toMatch(/Q: Which tone\?\nA: formal/)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  await ui.unmount()
})

test('"Use defaults and generate" answers the open questions and skips further rounds', async ($, on) => {
  const seen = engine(on, { replies: [TWO, 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })
  await ui.input({ key: 'answer-1-0', text: 'managers' })
  await ui.press({ key: 'defaults' })

  expect(seen.calls).toHaveLength(2)
  expect(seen.calls[1]?.prompt).toMatch(/A: managers\n\nQ: Which tone\?\nA: neutral \(default, accepted by the user\)/)
  await ui.unmount()
})

test('a medium prompt gets a second interview round', async ($, on) => {
  const seen = engine(on, { replies: [TWO, NONE, 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })
  await ui.input({ key: 'answer-1-0', text: '-' })
  await ui.input({ key: 'answer-1-1', text: '' })

  expect(seen.calls).toHaveLength(3)
  expect(seen.calls[1]?.prompt).toMatch(/round 2 of 2/)
  expect(seen.calls[1]?.prompt).toMatch(/A: \(skipped: let the target find out/)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  await ui.unmount()
})

test('an unreadable interview reply is skipped with a notice', async ($, on) => {
  const seen = engine(on, { replies: ['sure, here you go', 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  expect(seen.toasts.join(' ')).toMatch(/unreadable/)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  await ui.unmount()
})

test('a failed model call shows why and leaves the compose stage usable', async ($, on) => {
  const seen = engine(on, { replies: [NONE, { status: 529, error: 'overloaded' }, NONE, 'OPTIMIZED'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  expect(await ui.find({ type: 'Text', text: 'Failed: API error 529 (overloaded)' })).toBeDefined()
  expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('write docs')
  await ui.press({ key: 'generate' })
  expect(seen.calls).toHaveLength(4)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  await ui.unmount()
})

test('a model id the engine refuses shows as a failure', async ($, on) => {
  engine(on, { deny: 'model "nope" is not available' })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  expect(await ui.find({ type: 'Text', text: /^Failed: .*not available/ })).toBeDefined()
  await ui.unmount()
})

test('a cancelled call says so', async ($, on) => {
  engine(on, { replies: [{ aborted: true }] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  expect(await ui.find({ type: 'Text', text: 'Cancelled.' })).toBeDefined()
  expect(await ui.find({ key: 'prompt' })).toBeDefined()
  await ui.unmount()
})

test('an empty prompt asks for one and calls no model', async ($, on) => {
  const seen = engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'prompt', text: '   ' })

  expect(await ui.find({ type: 'Text', text: 'Type a prompt first.' })).toBeDefined()
  expect(seen.calls).toHaveLength(0)
  await ui.unmount()
})

test('with the context box ticked the recent conversation rides along', async ($, on) => {
  const seen = engine(on, {
    replies: [NONE, 'OPTIMIZED'],
    messages: [
      { role: 'user', text: 'the login page crashes' },
      { role: 'assistant', text: 'The crash is in auth.ts.' },
    ],
  })
  await open($, 'fix that')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'context' })
  await ui.press({ key: 'generate' })

  expect(seen.calls[1]?.prompt).toMatch(
    /<session_context>\nUser: the login page crashes\n\nAssistant: The crash is in auth\.ts\.\n<\/session_context>/,
  )
  await ui.unmount()
})

test('without the context box the conversation is not read', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'], messages: [{ role: 'user', text: 'secret' }] })
  await open($, 'fix that')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  expect(seen.messageReads).toBe(0)
  expect(seen.calls[1]?.prompt).not.toMatch(/session_context>\n/)
  await ui.unmount()
})

test('the prompt is written for this session unless another target is picked', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'ONE', NONE, 'TWO'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'target' }))?.props.value).toBe('session')
  await ui.press({ key: 'generate' })
  expect(seen.calls[1]?.prompt).toMatch(/Claude Code/)

  await ui.press({ key: 'edit' })
  await ui.select({ key: 'target', value: 'gemini' })
  await ui.press({ key: 'generate' })
  expect(seen.calls[2]?.prompt).toMatch(/a Gemini model/)
  expect(seen.calls[3]?.prompt).toMatch(/a Gemini model/)
  expect(seen.calls[3]?.prompt).not.toMatch(/Claude Code/)
  await ui.unmount()
})
