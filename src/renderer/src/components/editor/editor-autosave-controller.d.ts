import type { StoreApi } from 'zustand';
import type { AppState } from '@/store';
type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>;
export declare function attachEditorAutosaveController(store: AppStoreApi): () => void;
export declare function attachAppEditorAutosaveController(): () => void;
export {};
