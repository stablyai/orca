// Words that say an Antigravity account or model ran out of quota: agy's own sentences ("Individual
// quota reached.", "You have exhausted your quota on this model.") and Google's 429 status and
// sentences behind them. The host reads them only in agy's failure reports; a client in a
// failure's text. Disk quotas ("disc quota exceeded") are not usage limits.
export const ANTIGRAVITY_QUOTA_WORDS =
  /individual quota reached|exhausted your (?:quota|capacity) on this model|RESOURCE_EXHAUSTED|exceeded your current quota|quota exceeded for|usage limit reached/i
