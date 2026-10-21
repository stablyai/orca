export const WORK_INBOX_ROUTING_INSTRUCTIONS =
  'Use ask_user to send a question to the human inbox. If pending, call wait_for_answer with the same question ID. After reading an answer, call acknowledge_answer before continuing. A timeout, disconnection, or closure without an answer is never approval. Do not choose a suggested option on behalf of the user.'
