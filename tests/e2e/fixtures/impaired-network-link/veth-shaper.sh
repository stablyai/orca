#!/usr/bin/env bash
# Shapes the traffic of one other container from outside it, on the host side of its veth pair.
#
# Run with --privileged --net=host --pid=host. The veth is a forwarding hop between the two TCP
# endpoints, so neither sender's stack learns about a drop except by missing an ACK. That is where
# netem has to sit for TCP behaviour to be realistic (tc-netem(8): "netem must be placed on the
# ingress of the receiver host").
#
# TARGET_PID is the container's init process and TARGET_IP the address on the interface to shape.
# After start, /run/shaper/up names the device carrying client -> container packets and
# /run/shaper/down the one carrying container -> client packets.
set -euo pipefail

target_pid=${TARGET_PID:?}
target_ip=${TARGET_IP:?}
ifb=${IFB_NAME:?}

in_target() {
  nsenter -t "$target_pid" -n "$@"
}

target_device=$(in_target ip -o -4 addr show |
  awk -v ip="$target_ip" '{ split($4, a, "/"); if (a[1] == ip) print $2 }' | head -1)
if [[ -z "$target_device" ]]; then
  echo "no interface with address $target_ip in the target" >&2
  exit 1
fi
peer_index=$(in_target ip -o link show dev "$target_device" |
  sed -n 's/^[0-9]*: [^@]*@if\([0-9]*\):.*/\1/p')
# Why only veths: on macvlan or ipvlan the peer index is the host's own NIC, and shaping that
# would impair the machine running the tests.
veth=$(ip -o link show type veth |
  awk -F': ' -v i="$peer_index" '$1 == i { print $2 }' | cut -d@ -f1)
if [[ -z "$veth" ]]; then
  echo "$target_device in the target is not one end of a veth pair on this host" >&2
  exit 1
fi

created_ifb=0
created_clsact=0
previous_target_segments=
previous_veth_segments=

segments_of() {
  sed -n 's/.*gso_max_segs \([0-9]*\).*/\1/p' | head -1
}

teardown() {
  # Removes only what this instance made, so a second shaper that failed to start cannot strip
  # the first one's rules.
  if [[ $created_clsact == 1 ]]; then
    tc qdisc del dev "$veth" root 2>/dev/null || true
    tc qdisc del dev "$veth" clsact 2>/dev/null || true
  fi
  if [[ $created_ifb == 1 ]]; then
    ip link del "$ifb" 2>/dev/null || true
  fi
  if [[ -n "$previous_target_segments" ]]; then
    in_target ip link set dev "$target_device" gso_max_segs "$previous_target_segments" 2>/dev/null || true
  fi
  if [[ -n "$previous_veth_segments" ]]; then
    ip link set dev "$veth" gso_max_segs "$previous_veth_segments" 2>/dev/null || true
  fi
}
trap teardown EXIT
trap 'exit 0' TERM INT

ip link add "$ifb" type ifb
created_ifb=1
ip link set "$ifb" up
tc qdisc add dev "$veth" clsact
created_clsact=1
# Why: tc can only delay what a device sends. Packets the container sends arrive on the veth, so
# they are redirected to an ifb device and shaped as that device sends them on.
tc filter add dev "$veth" ingress pref 10 protocol all u32 match u32 0 0 \
  action mirred egress redirect dev "$ifb"

# Why: TCP hands the device bundles of several segments and they are split only after the qdisc,
# so netem would drop, count and rate-limit bundles. One segment per packet on both senders makes
# its loss, limit and rate apply to what crosses a real link. Offload flags alone do not do this.
previous_target_segments=$(in_target ip -d -o link show dev "$target_device" | segments_of)
previous_veth_segments=$(ip -d -o link show dev "$veth" | segments_of)
in_target ip link set dev "$target_device" gso_max_segs 1
ip link set dev "$veth" gso_max_segs 1
ethtool -K "$veth" gro off >/dev/null 2>&1 || true

mkdir -p /run/shaper
echo "$veth" > /run/shaper/up
echo "$ifb" > /run/shaper/down

sleep infinity &
wait $!
