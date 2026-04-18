/**
 * Stateful BEL detector that correctly ignores BEL (0x07) bytes
 * occurring inside OSC escape sequences.
 *
 * Why stateful: PTY data arrives in arbitrary chunks, so an OSC sequence
 * may span multiple calls. The detector tracks in-progress escape state
 * across invocations so a BEL used as an OSC terminator is never
 * misinterpreted as a terminal bell.
 */
export declare function createBellDetector(): (data: string) => boolean;
