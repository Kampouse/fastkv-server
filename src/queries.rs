use scylla::frame::types::Consistency;
use scylla::statement::Statement;

pub fn build_prefix_query(prefix: &str, table_name: &str) -> (Statement, String, String) {
    let columns = "predecessor_id, current_account_id, key, value, block_height, block_timestamp, receipt_id, tx_hash";
    let query_text = format!(
        "SELECT {} FROM {} WHERE predecessor_id = ? AND current_account_id = ? AND key >= ? AND key < ?",
        columns, table_name
    );

    let mut stmt = Statement::new(query_text);
    stmt.set_consistency(Consistency::LocalOne);
    stmt.set_request_timeout(Some(std::time::Duration::from_secs(10)));

    let prefix_start = prefix.to_string();
    let prefix_end = compute_prefix_end(prefix);

    (stmt, prefix_start, prefix_end)
}

pub fn build_count_query(prefix: Option<&str>, table_name: &str) -> (Statement, String, String) {
    let (query_text, prefix_start, prefix_end) = match prefix {
        Some(prefix) => {
            let query_text = format!(
                "SELECT COUNT(*) FROM {} WHERE predecessor_id = ? AND current_account_id = ? AND key >= ? AND key < ?",
                table_name
            );
            (query_text, prefix.to_string(), compute_prefix_end(prefix))
        }
        None => {
            let query_text = format!(
                "SELECT COUNT(*) FROM {} WHERE predecessor_id = ? AND current_account_id = ?",
                table_name
            );
            (query_text, String::new(), String::new())
        }
    };

    let mut stmt = Statement::new(query_text);
    stmt.set_request_timeout(Some(std::time::Duration::from_secs(10)));

    (stmt, prefix_start, prefix_end)
}

pub fn build_keys_prefix_query(prefix: &str, table_name: &str) -> (Statement, String, String) {
    let query_text = format!(
        "SELECT key FROM {} WHERE predecessor_id = ? AND current_account_id = ? AND key >= ? AND key < ?",
        table_name
    );

    let mut stmt = Statement::new(query_text);
    stmt.set_consistency(Consistency::LocalOne);
    stmt.set_request_timeout(Some(std::time::Duration::from_secs(10)));

    let prefix_start = prefix.to_string();
    let prefix_end = compute_prefix_end(prefix);

    (stmt, prefix_start, prefix_end)
}

pub fn compute_prefix_end(prefix: &str) -> String {
    // For prefix "graph/follow/", return "graph/follow/\xff"
    // This ensures we capture all keys starting with the prefix
    format!("{}\u{ff}", prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_prefix_end() {
        assert_eq!(compute_prefix_end("graph/follow/"), "graph/follow/\u{ff}");
        assert_eq!(compute_prefix_end("test"), "test\u{ff}");
        assert_eq!(compute_prefix_end(""), "\u{ff}");
    }

    #[test]
    fn test_build_prefix_query() {
        let (_stmt, start, end) = build_prefix_query("graph/follow/", "s_kv_last");
        assert_eq!(start, "graph/follow/");
        assert_eq!(end, "graph/follow/\u{ff}");
    }

    #[test]
    fn test_build_count_query_with_prefix() {
        let (_, start, end) = build_count_query(Some("graph/"), "s_kv_last");
        assert_eq!(start, "graph/");
        assert_eq!(end, "graph/\u{ff}");
    }

    #[test]
    fn test_build_count_query_without_prefix() {
        let (_, start, end) = build_count_query(None, "s_kv_last");
        assert!(start.is_empty());
        assert!(end.is_empty());
    }

    #[test]
    fn test_build_keys_prefix_query() {
        let (_, start, end) = build_keys_prefix_query("widget/", "s_kv_last");
        assert_eq!(start, "widget/");
        assert_eq!(end, "widget/\u{ff}");
    }
}
