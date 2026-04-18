import { describe, expect, it } from 'vitest';
import { syncPRChecksStatus, normalizeBranchName } from './github-checks';
describe('normalizeBranchName', () => {
    it('strips refs/heads/ prefix', () => {
        expect(normalizeBranchName('refs/heads/main')).toBe('main');
    });
    it('returns branch as-is when no prefix', () => {
        expect(normalizeBranchName('feature/foo')).toBe('feature/foo');
    });
    it('returns empty string for refs/heads/ only', () => {
        expect(normalizeBranchName('refs/heads/')).toBe('');
    });
});
describe('syncPRChecksStatus', () => {
    const baseState = {
        prCache: {
            '/repo::main': {
                fetchedAt: 0,
                data: { checksStatus: 'neutral' }
            }
        }
    };
    it('returns null for undefined branch', () => {
        expect(syncPRChecksStatus(baseState, '/repo', undefined, [])).toBeNull();
    });
    it('returns null for empty string branch', () => {
        expect(syncPRChecksStatus(baseState, '/repo', '', [])).toBeNull();
    });
    it('returns null for refs/heads/ only (normalizes to empty)', () => {
        expect(syncPRChecksStatus(baseState, '/repo', 'refs/heads/', [])).toBeNull();
    });
});
