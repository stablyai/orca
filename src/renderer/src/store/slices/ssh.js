export const createSshSlice = (set) => ({
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    sshCredentialQueue: [],
    setSshConnectionState: (targetId, state) => set((s) => {
        const next = new Map(s.sshConnectionStates);
        next.set(targetId, state);
        return { sshConnectionStates: next };
    }),
    setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
    enqueueSshCredentialRequest: (req) => set((s) => ({ sshCredentialQueue: [...s.sshCredentialQueue, req] })),
    removeSshCredentialRequest: (requestId) => set((s) => ({
        sshCredentialQueue: s.sshCredentialQueue.filter((req) => req.requestId !== requestId)
    }))
});
