ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
         (ROW_NUMBER() OVER (
            PARTITION BY workspace_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY CASE WHEN type = 'folder' THEN 0 ELSE 1 END, name COLLATE "C", created_at
          ) * 10)::int AS rn
  FROM nodes
  WHERE deleted_at IS NULL
)
UPDATE nodes n
SET sort_order = ranked.rn
FROM ranked
WHERE n.id = ranked.id;

CREATE INDEX IF NOT EXISTS nodes_parent_sort_idx
  ON nodes (workspace_id, parent_id, sort_order)
  WHERE deleted_at IS NULL;
