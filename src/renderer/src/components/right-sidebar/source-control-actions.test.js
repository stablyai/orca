import { describe, expect, it } from 'vitest';
import { getSourceControlActions } from './source-control-actions';
describe('getSourceControlActions', () => {
    it('shows discard and stage actions for untracked files', () => {
        expect(getSourceControlActions('untracked')).toEqual(['discard', 'stage']);
    });
    it('shows discard and stage actions for unstaged files', () => {
        expect(getSourceControlActions('unstaged')).toEqual(['discard', 'stage']);
    });
    it('shows unstage action for staged files', () => {
        expect(getSourceControlActions('staged')).toEqual(['unstage']);
    });
});
