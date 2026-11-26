import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { engine, open, PANE } from './helpers'

const NONE = '{"questions":[]}'
const ONE = '{"questions":[{"question":"Who reads it?","default":"developers"}]}'

/** Opens the pane on `write docs` and generates, ending in the result stage. */
async function generated($: Engine) {
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })

  return ui
}

test('"Use" puts the prompt in the prompt box unsent, closes the pane and starts fresh next time', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'] })
  const ui = await generated($)
  await ui.press({ key: 'use' })

  expect(seen.fills).toEqual([{ text: 'OPTIMIZED', mode: 'replace' }])
  expect(seen.closes).toBe(1)
  expect(seen.toasts.join(' ')).toMatch(/in the prompt box/)
  await ui.unmount()

  await open($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ key: 'prompt' }))?.props.value).toBe('')
  await again.unmount()
})

test('when the prompt box refuses the text it goes to the clipboard', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'], isFilled: false })
  const ui = await generated($)
  await ui.press({ key: 'use' })

  expect(seen.copies).toEqual(['OPTIMIZED'])
  expect(seen.toasts.join(' ')).toMatch(/clipboard/)
  await ui.unmount()
})

test('when neither the prompt box nor the clipboard takes the text the result stays on screen', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'], isFilled: false, isCopied: false })
  const ui = await generated($)
  await ui.press({ key: 'use' })

  expect(seen.opens).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'OPTIMIZED' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /could not be placed/ })).toBeDefined()
  await ui.unmount()
})

test('another size rewrites only, with the answers kept', async ($, on) => {
  const seen = engine(on, { replies: [ONE, NONE, 'MEDIUM', 'SMALL'] })
  await open($, 'write docs')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'generate' })
  await ui.input({ key: 'answer-1-0', text: 'managers' })
  expect(await ui.find({ type: 'Text', text: 'MEDIUM' })).toBeDefined()
  expect((await ui.find({ key: 'size-medium' }))?.props.hotkey).toBe('2')

  await ui.press({ key: 'size-small' })
  expect(seen.calls).toHaveLength(4)
  expect(seen.calls[3]?.prompt).toMatch(/SIZE: SMALL/)
  expect(seen.calls[3]?.prompt).toMatch(/Q: Who reads it\?\nA: managers/)
  expect(await ui.find({ type: 'Text', text: 'SMALL' })).toBeDefined()
  await ui.unmount()
})

test('"Regenerate" writes the prompt again', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'FIRST', 'SECOND'] })
  const ui = await generated($)
  expect((await ui.find({ key: 'regenerate' }))?.props.hotkey).toBe('r')
  await ui.press({ key: 'regenerate' })

  expect(seen.calls).toHaveLength(3)
  expect(seen.calls[2]?.prompt).toMatch(/SIZE: MEDIUM/)
  expect(await ui.find({ type: 'Text', text: 'SECOND' })).toBeDefined()
  await ui.unmount()
})

test('a failed regenerate keeps the result on screen', async ($, on) => {
  engine(on, { replies: [NONE, 'FIRST', { status: 500, error: 'server_error' }] })
  const ui = await generated($)
  await ui.press({ key: 'regenerate' })

  expect(await ui.find({ type: 'Text', text: 'FIRST' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Failed: API error 500 (server_error)' })).toBeDefined()
  await ui.unmount()
})

test('"Edit prompt" goes back to the rough prompt', async ($, on) => {
  engine(on, { replies: [NONE, 'OPTIMIZED'] })
  const ui = await generated($)
  expect((await ui.find({ key: 'edit' }))?.props.hotkey).toBe('e')
  await ui.press({ key: 'edit' })

  expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('write docs')
  await ui.unmount()
})

test('"Copy" puts the result on the clipboard and keeps the pane open', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'OPTIMIZED'] })
  const ui = await generated($)
  await ui.press({ key: 'copy' })

  expect(seen.copies).toEqual(['OPTIMIZED'])
  expect(seen.closes).toBe(0)
  expect(await ui.find({ type: 'Text', text: 'Copied to the clipboard.' })).toBeDefined()
  await ui.unmount()
})

test('closing without "Use" keeps the rough prompt for next time', async ($, on) => {
  const seen = engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'prompt', text: 'half a thought', kind: 'change' })
  await ui.unmount()
  await open($) // the toggle closes the pane
  expect(seen.closes).toBe(1)

  await open($)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ key: 'prompt' }))?.props.value).toBe('half a thought')
  await again.unmount()
})

test('the result shows what the model thinks you are after, and a correction rewrites with it', async ($, on) => {
  const seen = engine(on, {
    replies: [NONE, '<goal>You want docs for newcomers.</goal><prompt>FIRST</prompt>', '<goal>You want an API reference.</goal><prompt>SECOND</prompt>'],
  })
  const ui = await generated($)
  expect(await ui.find({ type: 'Text', text: 'You want docs for newcomers.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'FIRST' })).toBeDefined()

  await ui.input({ key: 'goal', text: 'No: an API reference for integrators' })
  expect(seen.calls).toHaveLength(3)
  expect(seen.calls[2]?.prompt).toMatch(/<user_goal>\nNo: an API reference for integrators\n<\/user_goal>/)
  expect(await ui.find({ type: 'Text', text: 'You want an API reference.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'SECOND' })).toBeDefined()
  await ui.unmount()
})

test('a new run forgets the correction of the last one', async ($, on) => {
  const seen = engine(on, { replies: [NONE, 'FIRST', 'SECOND', NONE, 'THIRD'] })
  const ui = await generated($)
  await ui.input({ key: 'goal', text: 'something else' })
  await ui.press({ key: 'edit' })
  await ui.press({ key: 'generate' })

  expect(seen.calls[4]?.prompt).not.toMatch(/user_goal>\n/)
  await ui.unmount()
})
