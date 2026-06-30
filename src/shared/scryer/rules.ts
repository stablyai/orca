export const SCRYER_RULES = `1. One edge per relationship. Edges represent relationships, not individual data flows. Do NOT split a single interaction into separate "send" and "receive" edges. One edge captures the full interaction. Two edges between the same pair of nodes are only valid when they represent genuinely independent relationships.
2. Arrow direction = dependency. The arrow points from the initiator/requester toward the provider/dependency, for example "Web App" -> "API Server" -> "Database".
3. Descriptions match abstraction level. System = high-level purpose. Container = what it deploys as. Component = specific responsibility.
4. Technology labels must be accurate and concise, max 28 characters.
5. External systems are opaque. They should not have child nodes.
6. No frontend-to-database shortcuts. A frontend container should talk to an API/backend, not directly to a data store.
7. One node per real thing. Do not duplicate nodes at the same level to represent the same system/container/component.
8. Cross-level edges are intentional. Do not flag cross-level edges as duplicates or suggest removing them.
9. Containers are runtime boundaries. Start with process boundaries. Use a deployment group when split containers share a runtime.
10. Framework internals are not containers unless they have a distinct user-facing surface that deserves its own tour.
11. Components map to code structures: a class, module, package, folder, or file boundary. Third-party libraries are not components.
12. Message queues and topics are explicit. Model as A -> Queue -> B instead of A -> B with a "via queue" label.
13. Node names describe roles, not technology stacks. Technology details belong in the technology field.
14. Parent-child nesting IS the system-to-container relationship. A system node should not have edges to its own child containers.
15. Do not suggest reorganizing valid decompositions when the author has separated clear concerns.
16. System boundary = ownership boundary. Everything you build and deploy from that codebase is a container inside the system. External systems are third-party services you do not control.
17. Mentions imply edges. If a node description references another node with @[Name], there must be an edge connecting them directly or at the right parent level.
18. No cross-container component edges. Components are internal to their container. Edge from A's component to container B, not to B's component.
19. The C4 hierarchy is an authority hierarchy. Lower-level implementation discoveries that challenge higher-level boundaries require human review.

## Workflow
1. list_models to see existing diagrams.
2. Call get_structure with the project path to get the annotated directory tree. Read manifests it surfaces to identify runtime dependencies, external services, databases, and frameworks.
3. Model one level at a time.
   - First call set_model with persons, the system, external systems, and system-level edges only.
   - Second call set_node on the system to add all containers plus container-level edges. Then group containers that deploy together using set_groups.
   - Later, set_node per container to add components only when the user asks for deeper detail.
   - When adding components, model all components in that container, not just the new ones.
4. Edges must exist at every abstraction level.
5. Do not create flows during initial modeling. Flows are added later by the user or on explicit request.
6. When adding components, populate them with operation, process, and model nodes where the code has that detail. Models must use properties for fields. Operations map to individual functions/methods. Processes map to multi-step workflows.
7. Default workflow: model first, then wait. If the user asks to implement in the same request, go ahead.
8. Implementation loop. Use get_task to get the next implementation task. Build it, mark nodes as implemented via update_nodes with a reason, then call get_task again. Repeat until get_task returns "All tasks complete." Parent containers and systems are marked implemented via completion hints once all their children are done. When multiple containers are ready, use Orca's agent workflow per container instead of making a separate AI provider configuration here.
9. Verification is separate from implementation. A node is verified only when implementation is complete, behavior matches the description, relevant tests pass, and inherited expect contract items are passed.

## Authority Hierarchy
The model is a specification, not just documentation.

Changes flow down. System boundaries constrain containers. Container definitions constrain components. Component decisions constrain operations.

Questions flow up. If implementation reveals a higher-level boundary is wrong, do not silently modify the model. Flag the conflict and wait for human approval.

Requires human approval: adding/removing/renaming systems, restructuring containers, moving components between containers, or any change that alters boundaries at a higher level than where you are working.

Does not require approval: adding/modifying components and operations within existing boundaries, adding edges between existing nodes, updating descriptions/technology/status/source map, and detailing a node's internals when the user explicitly asked you to.`

export const TASK_INSTRUCTIONS = `The spec above is your source of truth. It tells you what to build.

If a Contract section is present, those are binding requirements from the user. MUST items are non-negotiable. ASK USER FIRST items require confirmation before deciding. NEVER items are hard constraints.

Status meanings:
- proposed: planned, no code yet.
- implemented: code exists but may be incomplete.
- verified: production-ready and gated by passed expect contract items.

After building:
1. Mark only the node(s) listed in the task as implemented using update_nodes. Include a reason explaining what was built.
2. Include source on every node. Containers and components use glob patterns. Operations use file pattern plus line/endLine.
3. Call get_task immediately to get the next task. Repeat until get_task returns "All tasks complete."

The architecture model is the source of truth. If code changes move, rename, delete, or restructure source-mapped behavior, update the model in the same loop.`
