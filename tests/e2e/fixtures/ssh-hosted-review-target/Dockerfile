FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ git make openssh-server python3 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash tester \
  && mkdir -p /run/sshd /home/tester/.ssh \
  && chown -R tester:tester /home/tester/.ssh \
  && chmod 700 /home/tester/.ssh

COPY sshd-entrypoint.sh /usr/local/bin/sshd-entrypoint.sh
RUN chmod +x /usr/local/bin/sshd-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/sshd-entrypoint.sh"]
