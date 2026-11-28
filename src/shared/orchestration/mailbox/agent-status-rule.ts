/** How to answer agent mail: once, only what it asks, with no acknowledgements. */
export const AGENT_MAIL_ANSWER_RULE =
  'When you answer agent mail, answer once and only what it asks; never send acknowledgements or thanks; write plain sentences with normal spacing.'

/** The one rule for where work stands, said the same way in every help, preamble and guide. */
export const AGENT_STATUS_RULE = `Status never wakes: put where your work stands on your item (bot) or task (worker), and read theirs there. To answer an agent waiting on you, reply to its message (orca orchestration reply --id <msg>); to make one act, or to pass on your owner's decision or an instruction, send a question or handoff (--item <n> for the item it is about). ${AGENT_MAIL_ANSWER_RULE}`
