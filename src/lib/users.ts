// Stand-in for a user directory. A real app looks users up in its auth provider.

export type User = {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly org: string;
};

export const users: readonly User[] = [
  { id: "alice", name: "Alice", orgId: "acme", org: "Acme" },
  { id: "bob", name: "Bob", orgId: "globex", org: "Globex" },
];

export function userById(id: string): User | undefined {
  return users.find((user) => user.id === id);
}
