import type { ProviderRateLimits } from '../../../../shared/rate-limit-types';
export declare function formatTimeAgo(ts: number): string;
export declare function ProviderIcon({ provider }: {
    provider: string;
}): React.JSX.Element;
export declare function ProviderTooltip({ p }: {
    p: ProviderRateLimits | null;
}): React.JSX.Element;
export declare function ProviderPanel({ p, inverted, className }: {
    p: ProviderRateLimits | null;
    inverted?: boolean;
    className?: string;
}): React.JSX.Element;
