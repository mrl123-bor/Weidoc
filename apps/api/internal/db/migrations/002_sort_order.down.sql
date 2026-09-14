DROP INDEX IF EXISTS nodes_parent_sort_idx;
ALTER TABLE nodes DROP COLUMN IF EXISTS sort_order;
