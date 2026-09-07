// Why: STA-2370 — widening the runtime listener to every interface is one-way for the life of the process
// and persists across launches, so it must follow the reach the user picked, not the shape of the address
// they typed: a Custom `127.0.0.1:8443` is usually an SSH tunnel or reverse proxy that still needs off-host
// reach, while "This computer only" must never publish the runtime beyond loopback.
export type RuntimePairingReach = 'this-computer' | 'network'
