import { expect, test } from './helpers/orca-app'
import { peerNativeWindow, expectNativeTabOrder } from './helpers/native-desktop-window'

test('a peer reorder is rendered and saved by an idle native window', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  const target = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const key = state?.activeWorktreeId
    if (!state || !key) {
      throw new Error('Missing workspace')
    }
    const added = state.createTab(key, undefined, undefined, { activate: false })
    const group = window.__store
      ?.getState()
      .groupsByWorktree[key]?.find((candidate) => candidate.tabOrder.includes(added.id))
    if (!group) {
      throw new Error('Missing group')
    }
    group.tabOrder.forEach((id, index) => {
      const tab = window.__store
        ?.getState()
        .unifiedTabsByWorktree[key]?.find((tab) => tab.id === id)
      if (tab?.contentType === 'terminal') {
        state.setTabCustomTitle(tab.entityId, `Peer order ${index + 1}`)
      }
    })
    return { key, groupId: group.id, order: group.tabOrder }
  })
  await expectNativeTabOrder(orcaPage, target.groupId, target.order)
  const peer = await peerNativeWindow(electronApp, orcaPage)
  await expectNativeTabOrder(peer, target.groupId, target.order)
  const reordered = target.order.toReversed()
  await peer.evaluate(
    ({ groupId, order }) => window.__store?.getState().reorderUnifiedTabs(groupId, order),
    { groupId: target.groupId, order: reordered }
  )
  await expectNativeTabOrder(peer, target.groupId, reordered)
  await expectNativeTabOrder(orcaPage, target.groupId, reordered)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        async ({ key, groupId }) =>
          (await window.api.session.get()).tabGroups?.[key]?.find(
            (candidate) => candidate.id === groupId
          )?.tabOrder,
        { key: target.key, groupId: target.groupId }
      )
    )
    .toEqual(reordered)
  const screenshot = testInfo.outputPath('native-peer-reorder.png')
  await orcaPage.screenshot({ path: screenshot })
  await testInfo.attach('native-peer-reorder', { path: screenshot, contentType: 'image/png' })
})
