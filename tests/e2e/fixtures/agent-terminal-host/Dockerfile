# A host for the terminal latency harness: an Orca server (the AppImage is mounted at run time),
# real Claude Code and Codex pointed at a local stub API, and a pager. No account is needed.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=2.1.289
ARG CODEX_VERSION=0.160.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep less procps tmux jq file util-linux python3 \
      dbus-x11 xvfb xauth libatk-bridge2.0-0 libatspi2.0-0 libasound2 libdrm2 libgbm1 libgtk-3-0 \
      libnss3 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      libcups2 libpango-1.0-0 libcairo2 libxrender1 libx11-xcb1 libxcb-dri3-0 zlib1g \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force

# Why an ordinary user: both CLIs behave differently as root, and the Orca server refuses it.
RUN useradd --create-home --shell /bin/bash agent
USER agent
ENV HOME=/home/agent LANG=C.UTF-8 TERM=xterm-256color
WORKDIR /home/agent

RUN git init -q -b main /home/agent/demo-repo \
 && cd /home/agent/demo-repo \
 && git config user.name "Stub Agent" && git config user.email "agent@example.invalid" \
 && printf '# demo-repo\n\nA tiny repository for terminal harness runs.\n' > README.md \
 && printf 'export function add(a, b) {\n  return a + b\n}\n' > add.js \
 && git add -A && git commit -q -m "Initial commit" \
 && for i in $(seq 1 400); do printf 'L%03d the quick brown fox jumps over the lazy dog\n' "$i"; done > /home/agent/lines.txt

COPY --chown=agent:agent stub-server.js run-claude.sh run-codex.sh start-stub.sh /opt/agent-terminal-host/
COPY --chown=agent:agent home/ /home/agent/
ENV PATH=/opt/agent-terminal-host:$PATH

WORKDIR /home/agent/demo-repo
CMD ["bash"]
