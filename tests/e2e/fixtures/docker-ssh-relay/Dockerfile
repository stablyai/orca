ARG SSH_BASE_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
FROM ${SSH_BASE_IMAGE}

# Why: immutable snapshot inputs keep the SSH/Git fixture identical across rebuild dates.
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260713T000000Z|' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260713T000000Z|' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git=1:2.39.5-0+deb12u3 \
      openssh-server=1:9.2p1-2+deb12u10 \
      ca-certificates \
      procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /root/.ssh \
    && chmod 700 /root/.ssh

EXPOSE 22
