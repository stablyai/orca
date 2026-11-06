Full comparison for this one example: [https://share.onorca.dev/a/VIruT485IdpP](https://share.onorca.dev/a/VIruT485IdpP)

Curious to hear what you find if you try it on your code

I stopped using GPT-6.1 Sol for code review. GPT-6.1 Terra is cheaper and it beat Sol.

Same PR, same prompt:

🐢 GPT-6.1 Sol (high): 93 seconds, $0.37  
⚡ 2× GPT-6.1 Terra (high): 17 seconds, $0.18

The cheap pair was 5× faster, cost half as much, and caught 2 bugs Sol missed. Sol's only edge was running the tests to prove its bugs.

Since every model misses bugs, even Sol, I never rely on one reviewer. My setup now:

1. Two Terra subagents review the PR in parallel
2. A third Terra has them debate and settle on the final findings
