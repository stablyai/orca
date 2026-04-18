import React from 'react';
import type { TuiAgent } from '../../../shared/types';
export type AgentCatalogEntry = {
    id: TuiAgent;
    label: string;
    /** Default CLI binary name used for PATH detection. */
    cmd: string;
    /** Domain for Google's favicon service — used for agents without an SVG icon. */
    faviconDomain?: string;
    /** Homepage/install docs URL, sourced from the README agent badge list. */
    homepageUrl: string;
};
export declare const AGENT_CATALOG: AgentCatalogEntry[];
export declare function AgentIcon({ agent, size }: {
    agent: TuiAgent;
    size?: number;
}): React.JSX.Element;
