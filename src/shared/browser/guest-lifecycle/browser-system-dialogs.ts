/** Main → guest frame: whether an agent drove the page since the desktop user last gave it input. */
export const BROWSER_AGENT_LEAD_CHANNEL = 'browser:agentLead'
/** Guest frame → main: a new document asks for the current lead; main answers on the lead channel. */
export const BROWSER_AGENT_LEAD_QUERY_CHANNEL = 'browser:agentLeadQuery'
/** Main → guest frame, answering the lead query: whether print() opens a dialog on this machine, false for a server page. */
export const BROWSER_PRINTS_HERE_CHANNEL = 'browser:printsHere'
/** Guest frame → main: the page's print() opened no dialog here, because the agent leads it or it is a server page. */
export const BROWSER_PRINT_REFUSED_CHANNEL = 'browser:printRefused'
export const BROWSER_SYSTEM_DIALOGS_PRELOAD_FILE = 'browser-system-dialogs-preload.js'
