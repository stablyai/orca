import { describe, expect, it, vi } from 'vitest';
import { splitPaneWithOneShotStartup } from './use-terminal-pane-lifecycle';
describe('splitPaneWithOneShotStartup', () => {
    it('only exposes startup to the intentional split and clears it afterwards', () => {
        const deps = {
            startup: null
        };
        const seenStartupValues = [];
        const createdPane = splitPaneWithOneShotStartup(deps, { command: 'orca setup', env: { ORCA_ROLE: 'setup' } }, () => {
            seenStartupValues.push(deps.startup ?? null);
            return { id: 2 };
        });
        expect(createdPane).toEqual({ id: 2 });
        expect(seenStartupValues).toEqual([{ command: 'orca setup', env: { ORCA_ROLE: 'setup' } }]);
        expect(deps.startup).toBeNull();
    });
    it('isolates startup payloads across sequential calls (setup then issue)', () => {
        const deps = {
            startup: null
        };
        const seenStartupValues = [];
        splitPaneWithOneShotStartup(deps, { command: 'orca setup', env: { ORCA_ROLE: 'setup' } }, () => {
            seenStartupValues.push(deps.startup ?? null);
            return { id: 2 };
        });
        expect(deps.startup).toBeNull();
        splitPaneWithOneShotStartup(deps, { command: 'orca issue' }, () => {
            seenStartupValues.push(deps.startup ?? null);
            return { id: 3 };
        });
        expect(seenStartupValues).toEqual([
            { command: 'orca setup', env: { ORCA_ROLE: 'setup' } },
            { command: 'orca issue' }
        ]);
        expect(deps.startup).toBeNull();
        const userSplitObservedStartup = ((splitPane) => {
            splitPane();
            return deps.startup ?? null;
        })(() => ({ id: 4 }));
        expect(userSplitObservedStartup).toBeNull();
        expect(deps.startup).toBeNull();
    });
    it('clears startup even when splitPane throws', () => {
        const deps = { startup: null };
        const splitPane = vi.fn(() => {
            throw new Error('split failed');
        });
        expect(() => splitPaneWithOneShotStartup(deps, { command: 'orca setup' }, splitPane)).toThrow('split failed');
        expect(splitPane).toHaveBeenCalledTimes(1);
        expect(deps.startup).toBeNull();
    });
});
