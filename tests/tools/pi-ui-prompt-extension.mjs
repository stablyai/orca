// Load with Pi's -e flag; /orca-modal exercises real dialogs without a model or API key.
export default function (pi) {
  pi.registerCommand('orca-modal', {
    description: 'Verify Orca status: select, confirm, input, editor, or custom',
    handler: async (args, ctx) => {
      const kind = args.trim() || 'select'
      const title = `Orca verification: ${kind}`
      let answer
      switch (kind) {
        case 'select':
          answer = await ctx.ui.select(title, ['Continue verification', 'Second option'])
          break
        case 'confirm':
          answer = await ctx.ui.confirm(title, 'Continue verification?')
          break
        case 'input':
          answer = await ctx.ui.input(title, 'Type a test answer')
          break
        case 'editor':
          answer = await ctx.ui.editor(title, 'Test answer')
          break
        case 'custom':
          answer = await ctx.ui.custom((_tui, _theme, keys, done) => ({
            render: () => [title, 'Press Enter to answer or Escape to cancel.'],
            invalidate() {},
            handleInput: (data) => {
              if (keys.matches(data, 'tui.select.confirm')) {
                done('answered')
              }
              if (keys.matches(data, 'tui.select.cancel')) {
                done(undefined)
              }
            }
          }))
          break
        default:
          ctx.ui.notify('Use select, confirm, input, editor, or custom', 'error')
          return
      }
      ctx.ui.notify(`Orca verification: ${kind} ${answer === undefined ? 'cancelled' : 'answered'}`)
    }
  })
}
