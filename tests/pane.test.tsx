import { expect, test } from 'claude-code/testing'

import { engine, open, PANE } from './helpers'

test('/promptimize opens a focused pane with the typed text as the rough prompt', async ($, on) => {
  const seen = engine(on)
  await open($, ' fix the bug ')

  expect(seen.opens[0]).toMatchObject({ id: 'promptimize', focus: true, closeOnEscape: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('fix the bug')
    await ui.unmount()
  }
})

test('the size buttons and the context box show the choice', async ($, on) => {
  engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'size-medium' }))?.text).toBe('(•) Medium')
  await ui.press({ key: 'size-large' })
  expect((await ui.find({ key: 'size-large' }))?.text).toBe('(•) Large')
  expect((await ui.find({ key: 'size-medium' }))?.text).toBe('( ) Medium')

  expect((await ui.find({ key: 'context' }))?.text).toBe('[ ] Include recent session context')
  await ui.press({ key: 'context' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('[x] Include recent session context')
  await ui.unmount()
})

test('typing survives a redraw caused by another control', async ($, on) => {
  engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'prompt', text: 'half a thought', kind: 'change' })
  await ui.press({ key: 'size-small' })
  expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('half a thought')
  await ui.unmount()
})

test('the model option wins, and its extra models are listed', { options: { model: 'opus', models: 'x-1, x-2' } }, async ($, on) => {
  engine(on, { settings: { model: 'from-settings' } })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const select = await ui.find({ key: 'model' })
  expect(select?.props.value).toBe('opus')
  expect(select?.props.options).toEqual(
    ['opus', 'from-settings', 'x-1', 'x-2', 'sonnet', 'haiku'].map(value => ({ value })),
  )
  await ui.select({ key: 'model', value: 'haiku' })
  expect((await ui.find({ key: 'model' }))?.props.value).toBe('haiku')
  await ui.unmount()
})

test("without the option the session's model setting is the default, else sonnet", async ($, on) => {
  engine(on, { settings: { model: 'from-settings' } })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'model' }))?.props.value).toBe('from-settings')
  await ui.unmount()
})

test('with no model configured anywhere the default is sonnet', async ($, on) => {
  engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'model' }))?.props.value).toBe('sonnet')
  await ui.unmount()
})

test('the includeContext option ticks the box from the start', { options: { includeContext: true } }, async ($, on) => {
  engine(on)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'context' }))?.text).toBe('[x] Include recent session context')
  await ui.unmount()
})

test('a value an earlier version stored is read as a fresh start', async ($, on) => {
  engine(on)
  on('state.get', () => ({ value: { value: { stage: 'result', result: 'old' }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'prompt' })).toBeDefined()
  await ui.unmount()
})

test('where no pane can open the command says so', async ($, on) => {
  engine(on, { isPlaced: false })
  const ran = await open($)
  expect(ran.text).toMatch(/could not open a pane/)
})

test('when another command holds /promptimize the pane opens as /promptimize-pane', async ($, on) => {
  const seen = engine(on, { isNameTaken: true })
  await open($, 'fix the bug', 'promptimize-pane')

  expect(seen.registered).toEqual(['promptimize', 'promptimize-pane'])
  expect(seen.opens).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'prompt' }))?.props.value).toBe('fix the bug')
  await ui.unmount()
})

test('with the name free only /promptimize is registered', async ($, on) => {
  const seen = engine(on)
  await open($)
  expect(seen.registered).toEqual(['promptimize'])
})
