/**
 * Stateful BEL detector that correctly ignores BEL (0x07) bytes
 * occurring inside OSC escape sequences.
 *
 * Why stateful: PTY data arrives in arbitrary chunks, so an OSC sequence
 * may span multiple calls. The detector tracks in-progress escape state
 * across invocations so a BEL used as an OSC terminator is never
 * misinterpreted as a terminal bell.
 */
export function createBellDetector() {
    let pendingEscape = false;
    let inOsc = false;
    let pendingOscEscape = false;
    return function chunkContainsBell(data) {
        for (let i = 0; i < data.length; i += 1) {
            const char = data[i];
            if (inOsc) {
                if (pendingOscEscape) {
                    pendingOscEscape = char === '\x1b';
                    if (char === '\\') {
                        inOsc = false;
                        pendingOscEscape = false;
                    }
                    continue;
                }
                if (char === '\x07') {
                    inOsc = false;
                    continue;
                }
                pendingOscEscape = char === '\x1b';
                continue;
            }
            if (pendingEscape) {
                pendingEscape = false;
                if (char === ']') {
                    inOsc = true;
                    pendingOscEscape = false;
                }
                else if (char === '\x1b') {
                    pendingEscape = true;
                }
                continue;
            }
            if (char === '\x1b') {
                pendingEscape = true;
                continue;
            }
            if (char === '\x07') {
                return true;
            }
        }
        return false;
    };
}
