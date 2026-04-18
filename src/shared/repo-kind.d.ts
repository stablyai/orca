import type { Repo } from './types';
export declare function getRepoKind(repo: Pick<Repo, 'kind'>): 'git' | 'folder';
export declare function isFolderRepo(repo: Pick<Repo, 'kind'>): boolean;
export declare function isGitRepoKind(repo: Pick<Repo, 'kind'>): boolean;
export declare function getRepoKindLabel(repo: Pick<Repo, 'kind'>): string;
