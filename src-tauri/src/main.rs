// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    
    // Check for --mcp-server flag to run as MCP server only (no GUI)
    if args.contains(&"--mcp-server".to_string()) {
        // SILENT: no output to stdout (used for JSON-RPC)
        // Logging goes to stderr via env_logger in start_mcp_server_standalone
        app_lib::run_mcp_server_only();
    } else {
        app_lib::run();
    }
}