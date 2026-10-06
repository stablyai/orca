FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends iproute2 iputils-ping socat ethtool util-linux ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY link-end.sh /usr/local/bin/link-end
COPY veth-shaper.sh /usr/local/bin/veth-shaper
