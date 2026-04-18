import { describe, expect, it } from 'vitest';
import { canDropTabIntoPaneBody } from './useTabDragSplit';
function makeGroup(id, tabOrder) {
    return {
        id,
        worktreeId: 'wt-1',
        activeTabId: tabOrder[0] ?? null,
        tabOrder
    };
}
function makeDragData(groupId, unifiedTabId = 'tab-1') {
    return {
        kind: 'tab',
        worktreeId: 'wt-1',
        groupId,
        unifiedTabId,
        visibleTabId: unifiedTabId,
        tabType: 'editor'
    };
}
describe('canDropTabIntoPaneBody', () => {
    it('rejects pane-body drops that would split a single tab onto itself', () => {
        expect(canDropTabIntoPaneBody({
            activeDrag: makeDragData('group-1'),
            groupsByWorktree: { 'wt-1': [makeGroup('group-1', ['tab-1'])] },
            overGroupId: 'group-1',
            worktreeId: 'wt-1'
        })).toBe(false);
    });
    it('allows same-group pane-body drops when the group still has other tabs', () => {
        expect(canDropTabIntoPaneBody({
            activeDrag: makeDragData('group-1'),
            groupsByWorktree: { 'wt-1': [makeGroup('group-1', ['tab-1', 'tab-2'])] },
            overGroupId: 'group-1',
            worktreeId: 'wt-1'
        })).toBe(true);
    });
    it('allows pane-body drops into a different group', () => {
        expect(canDropTabIntoPaneBody({
            activeDrag: makeDragData('group-1'),
            groupsByWorktree: {
                'wt-1': [makeGroup('group-1', ['tab-1']), makeGroup('group-2', ['tab-2'])]
            },
            overGroupId: 'group-2',
            worktreeId: 'wt-1'
        })).toBe(true);
    });
});
