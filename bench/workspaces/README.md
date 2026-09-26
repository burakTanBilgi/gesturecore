Saved bench workspaces, one JSON file each.

Written by the bench through /__workspaces while the dev server is running. This folder
is the current storage backend, not the design: the bench talks to a WorkspaceStore
interface, so a deployed bench can keep workspaces somewhere else without changing the
panel code.
