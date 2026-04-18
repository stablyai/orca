import type { AppState } from '../types';
import type { PRCheckDetail, CheckStatus } from '../../../../shared/types';
export declare function normalizeBranchName(branch: string): string;
export declare function deriveCheckStatusFromChecks(checks: PRCheckDetail[]): CheckStatus;
export declare function syncPRChecksStatus(state: AppState, repoPath: string, branch: string | undefined, checks: PRCheckDetail[]): Partial<AppState> | null;
