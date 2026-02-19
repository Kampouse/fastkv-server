//! Encrypted KV handlers using OutLayer TEE Key Manager
//!
//! These endpoints provide encrypted storage where the server never
//! has access to the decryption keys - they exist only in the TEE.

use crate::handlers::validate_account_id;
use crate::models::*;
use crate::AppState;
use actix_web::{get, post, web, HttpResponse};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

const OUTLAYER_CONTRACT: &str = "outlayer.near";
const OUTLAYER_API: &str = "https://api.outlayer.fastnear.com";
const KEY_MANAGER_WASM: &str = "https://github.com/Kampouse/key-manager/releases/download/v0.2.0/key-manager.wasm";
const KEY_MANAGER_HASH: &str = "44ce9f1f616e765f21fe208eb1ff4db29a7aac90096ca83cf75864793c21e7d3";

// ============ Request/Response Types ============

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedSetBody {
    /// Owner account ID (must match X-Payment-Key owner)
    pub account_id: String,
    /// Plaintext value to encrypt
    pub value: String,
    /// Optional group ID (defaults to account_id/private)
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedGetBody {
    /// Owner account ID
    pub account_id: String,
    /// Ciphertext to decrypt (enc:AES256:... format)
    pub ciphertext: String,
    /// Optional group ID (defaults to account_id/private)
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedBatchBody {
    /// Owner account ID
    pub account_id: String,
    /// Items to encrypt
    pub items: Vec<EncryptedBatchItem>,
    /// Optional group ID (defaults to account_id/private)
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedBatchItem {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedResponse {
    /// Encrypted value in format: enc:AES256:<key_id>:<ciphertext_b64>
    pub encrypted_value: String,
    /// Key ID used for encryption
    pub key_id: String,
    /// Attestation hash proving TEE execution
    pub attestation: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DecryptedResponse {
    /// Decrypted plaintext (UTF-8 if valid, otherwise base64)
    pub plaintext: String,
    /// Plaintext as UTF-8 string (null if not valid UTF-8)
    pub plaintext_utf8: Option<String>,
    /// Key ID used for decryption
    pub key_id: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedBatchResponse {
    pub key_id: String,
    pub items: Vec<EncryptedBatchItemResponse>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EncryptedBatchItemResponse {
    pub key: String,
    pub encrypted_value: String,
    pub error: Option<String>,
}

// ============ OutLayer Client ============

#[derive(Debug, Serialize)]
struct OutLayerRequest {
    source: OutLayerSource,
    input_data: String,
    resource_limits: ResourceLimits,
    response_format: String,
}

#[derive(Debug, Serialize)]
struct OutLayerSource {
    #[serde(rename = "WasmUrl")]
    wasm_url: WasmUrlSource,
}

#[derive(Debug, Serialize)]
struct WasmUrlSource {
    url: String,
    hash: String,
    build_target: String,
}

#[derive(Debug, Serialize)]
struct ResourceLimits {
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u32,
}

/// Call OutLayer Key Manager
async fn call_key_manager(
    payment_key: &str,
    action: &str,
    group_id: &str,
    account_id: &str,
    extra_fields: Option<serde_json::Value>,
) -> Result<serde_json::Value, ErrorResponse> {
    // Build request
    let mut request = serde_json::json!({
        "action": action,
        "group_id": group_id,
        "account_id": account_id,
    });

    if let Some(fields) = extra_fields {
        if let serde_json::Value::Object(ref mut map) = request {
            if let serde_json::Value::Object(extra) = fields {
                for (k, v) in extra {
                    map.insert(k.clone(), v.clone());
                }
            }
        }
    }

    let outlayer_request = OutLayerRequest {
        source: OutLayerSource {
            wasm_url: WasmUrlSource {
                url: KEY_MANAGER_WASM.to_string(),
                hash: KEY_MANAGER_HASH.to_string(),
                build_target: "wasm32-wasip1".to_string(),
            },
        },
        input_data: serde_json::to_string(&request).unwrap_or_default(),
        resource_limits: ResourceLimits {
            max_instructions: 10_000_000_000,
            max_memory_mb: 128,
            max_execution_seconds: 60,
        },
        response_format: "Json".to_string(),
    };

    // Call OutLayer
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/call/Kampouse/key-manager", OUTLAYER_API))
        .header("Content-Type", "application/json")
        .header("X-Payment-Key", payment_key)
        .json(&outlayer_request)
        .send()
        .await
        .map_err(|e| ErrorResponse {
            error: format!("OutLayer request failed: {}", e),
            code: ErrorCode::DatabaseUnavailable,
        })?;

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ErrorResponse {
            error: format!("Invalid OutLayer response: {}", e),
            code: ErrorCode::DatabaseUnavailable,
        })?;

    // Check for errors
    if let Some(error) = result.get("error") {
        return Err(ErrorResponse {
            error: format!("Key Manager error: {}", error),
            code: ErrorCode::InvalidParameter,
        });
    }

    Ok(result)
}

// ============ Handlers ============

/// Encrypt a value
///
/// Encrypts plaintext using TEE-derived key. Server never sees the key.
#[utoipa::path(
    post,
    path = "/v1/kv/encrypted/encrypt",
    tag = "encrypted",
    request_body = EncryptedSetBody,
    responses(
        (status = 200, description = "Value encrypted", body = EncryptedResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 401, description = "Missing payment key", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
#[post("/v1/kv/encrypted/encrypt")]
pub async fn encrypted_encrypt_handler(
    _state: web::Data<AppState>,
    body: web::Json<EncryptedSetBody>,
    req: actix_web::HttpRequest,
) -> HttpResponse {
    // Get payment key from header
    let payment_key = match req.headers().get("X-Payment-Key") {
        Some(h) => h.to_str().unwrap_or("").to_string(),
        None => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: "Missing X-Payment-Key header".to_string(),
                code: ErrorCode::InvalidParameter,
            });
        }
    };

    let group_id = body
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}/private", body.account_id));

    // Validate
    if let Err(e) = validate_account_id(&body.account_id, "account_id") {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: e.to_string(),
            code: e.code(),
        });
    }

    // Encode plaintext to base64
    let plaintext_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &body.value);

    // Call key-manager
    match call_key_manager(
        &payment_key,
        "encrypt",
        &group_id,
        &body.account_id,
        Some(serde_json::json!({ "plaintext_b64": plaintext_b64 })),
    )
    .await
    {
        Ok(result) => {
            let ciphertext_b64 = result["ciphertext_b64"].as_str().unwrap_or("");
            let key_id = result["key_id"].as_str().unwrap_or("");

            HttpResponse::Ok().json(EncryptedResponse {
                encrypted_value: format!("enc:AES256:{}:{}", key_id, ciphertext_b64),
                key_id: key_id.to_string(),
                attestation: result["attestation_hash"].as_str().map(|s| s.to_string()),
            })
        }
        Err(e) => HttpResponse::BadRequest().json(e),
    }
}

/// Decrypt a value
///
/// Decrypts ciphertext using TEE-derived key. Server never sees the key.
#[utoipa::path(
    post,
    path = "/v1/kv/encrypted/decrypt",
    tag = "encrypted",
    request_body = EncryptedGetBody,
    responses(
        (status = 200, description = "Value decrypted", body = DecryptedResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 401, description = "Missing payment key", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
#[post("/v1/kv/encrypted/decrypt")]
pub async fn encrypted_decrypt_handler(
    _state: web::Data<AppState>,
    body: web::Json<EncryptedGetBody>,
    req: actix_web::HttpRequest,
) -> HttpResponse {
    // Get payment key from header
    let payment_key = match req.headers().get("X-Payment-Key") {
        Some(h) => h.to_str().unwrap_or("").to_string(),
        None => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: "Missing X-Payment-Key header".to_string(),
                code: ErrorCode::InvalidParameter,
            });
        }
    };

    let group_id = body
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}/private", body.account_id));

    // Parse encrypted value format: enc:AES256:key_id:ciphertext_b64
    let parts: Vec<&str> = body.ciphertext.split(':').collect();
    let ciphertext_b64 = if parts.len() == 4 && parts[0] == "enc" && parts[1] == "AES256" {
        parts[3].to_string()
    } else if body.ciphertext.starts_with("enc:") {
        // Invalid format
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "Invalid encrypted value format. Expected: enc:AES256:<key_id>:<ciphertext>"
                .to_string(),
            code: ErrorCode::InvalidParameter,
        });
    } else {
        // Assume it's raw ciphertext
        body.ciphertext.clone()
    };

    // Call key-manager
    match call_key_manager(
        &payment_key,
        "decrypt",
        &group_id,
        &body.account_id,
        Some(serde_json::json!({ "ciphertext_b64": ciphertext_b64 })),
    )
    .await
    {
        Ok(result) => {
            let plaintext_b64 = result["plaintext_b64"].as_str().unwrap_or("");
            let plaintext_utf8 = result["plaintext_utf8"].as_str();

            // Decode base64
            let plaintext = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, plaintext_b64)
                .unwrap_or_default();
            let plaintext_str = String::from_utf8_lossy(&plaintext).to_string();

            HttpResponse::Ok().json(DecryptedResponse {
                plaintext: plaintext_str,
                plaintext_utf8: plaintext_utf8.map(|s| s.to_string()),
                key_id: result["key_id"].as_str().unwrap_or("").to_string(),
            })
        }
        Err(e) => HttpResponse::BadRequest().json(e),
    }
}

/// Batch encrypt values
///
/// Encrypts multiple values in one call (more efficient).
#[utoipa::path(
    post,
    path = "/v1/kv/encrypted/batch-encrypt",
    tag = "encrypted",
    request_body = EncryptedBatchBody,
    responses(
        (status = 200, description = "Values encrypted", body = EncryptedBatchResponse),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 401, description = "Missing payment key", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
#[post("/v1/kv/encrypted/batch-encrypt")]
pub async fn encrypted_batch_encrypt_handler(
    _state: web::Data<AppState>,
    body: web::Json<EncryptedBatchBody>,
    req: actix_web::HttpRequest,
) -> HttpResponse {
    // Get payment key from header
    let payment_key = match req.headers().get("X-Payment-Key") {
        Some(h) => h.to_str().unwrap_or("").to_string(),
        None => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: "Missing X-Payment-Key header".to_string(),
                code: ErrorCode::InvalidParameter,
            });
        }
    };

    let group_id = body
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}/private", body.account_id));

    // Encode all items to base64
    let items: Vec<serde_json::Value> = body
        .items
        .iter()
        .map(|item| {
            let plaintext_b64 =
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &item.value);
            serde_json::json!({
                "key": item.key,
                "plaintext_b64": plaintext_b64
            })
        })
        .collect();

    // Call key-manager
    match call_key_manager(
        &payment_key,
        "batch_encrypt",
        &group_id,
        &body.account_id,
        Some(serde_json::json!({ "items": items })),
    )
    .await
    {
        Ok(result) => {
            let key_id = result["key_id"].as_str().unwrap_or("").to_string();

            let items: Vec<EncryptedBatchItemResponse> = result["items"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|item| EncryptedBatchItemResponse {
                            key: item["key"].as_str().unwrap_or("").to_string(),
                            encrypted_value: format!(
                                "enc:AES256:{}:{}",
                                &key_id,
                                item["ciphertext_b64"].as_str().unwrap_or("")
                            ),
                            error: item["error"].as_str().map(|s| s.to_string()),
                        })
                        .collect()
                })
                .unwrap_or_default();

            HttpResponse::Ok().json(EncryptedBatchResponse { key_id, items })
        }
        Err(e) => HttpResponse::BadRequest().json(e),
    }
}

// ============ Transaction-based Endpoints (No Payment Key) ============

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PrepareEncryptBody {
    /// NEAR account ID (will sign and pay for transaction)
    pub account_id: String,
    /// Plaintext value to encrypt
    pub value: String,
    /// Optional group ID (defaults to account_id/private)
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PrepareDecryptBody {
    /// NEAR account ID
    pub account_id: String,
    /// Ciphertext to decrypt
    pub ciphertext: String,
    /// Optional group ID
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct PreparedTransaction {
    /// NEAR transaction object to sign
    pub transaction: NearTransactionJson,
    /// URL to submit signed transaction (optional)
    pub submit_url: String,
    /// Instructions for signing
    pub instructions: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct NearTransactionJson {
    /// Contract to call
    pub receiver_id: String,
    /// Method to call
    pub method_name: String,
    /// Arguments (base64 encoded)
    pub args: String,
    /// Deposit in yoctoNEAR
    pub deposit: String,
    /// Gas limit
    pub gas: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ResultQuery {
    /// Transaction hash from NEAR blockchain
    pub tx_hash: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TransactionResult {
    /// Success status
    pub success: bool,
    /// Encrypted/decrypted value (if successful)
    pub result: Option<serde_json::Value>,
    /// Error message (if failed)
    pub error: Option<String>,
}

/// Prepare encrypt transaction
///
/// Returns an unsigned NEAR transaction for the user to sign.
/// User signs and submits to NEAR blockchain (~0.001 NEAR cost).
#[utoipa::path(
    post,
    path = "/v1/kv/encrypted/prepare-encrypt",
    tag = "encrypted",
    request_body = PrepareEncryptBody,
    responses(
        (status = 200, description = "Transaction prepared", body = PreparedTransaction),
        (status = 400, description = "Invalid request", body = ErrorResponse),
    )
)]
#[post("/v1/kv/encrypted/prepare-encrypt")]
pub async fn encrypted_prepare_encrypt_handler(
    body: web::Json<PrepareEncryptBody>,
) -> HttpResponse {
    let group_id = body
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}/private", body.account_id));

    // Validate
    if let Err(e) = validate_account_id(&body.account_id, "account_id") {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: e.to_string(),
            code: e.code(),
        });
    }

    // Encode plaintext to base64
    let plaintext_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &body.value);

    // Build OutLayer request
    let input_data = serde_json::json!({
        "action": "encrypt",
        "group_id": group_id,
        "account_id": body.account_id,
        "plaintext_b64": plaintext_b64,
    });

    // Build NEAR transaction args
    let tx_args = serde_json::json!({
        "source": {
            "WasmUrl": {
                "url": KEY_MANAGER_WASM,
                "hash": KEY_MANAGER_HASH,
                "build_target": "wasm32-wasip1"
            }
        },
        "input_data": serde_json::to_string(&input_data).unwrap_or_default(),
        "resource_limits": {
            "max_instructions": "10000000000",
            "max_memory_mb": 128,
            "max_execution_seconds": 60
        },
        "response_format": "Json"
    });

    let args_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_vec(&tx_args).unwrap_or_default()
    );

    HttpResponse::Ok().json(PreparedTransaction {
        transaction: NearTransactionJson {
            receiver_id: OUTLAYER_CONTRACT.to_string(),
            method_name: "request_execution".to_string(),
            args: args_b64,
            deposit: "50000000000000000000000".to_string(), // 0.05 NEAR
            gas: "300000000000000".to_string(),
        },
        submit_url: "https://wallet.near.org/sign".to_string(),
        instructions: "Sign this transaction with your NEAR wallet. Cost: ~0.05 NEAR".to_string(),
    })
}

/// Prepare decrypt transaction
///
/// Returns an unsigned NEAR transaction for the user to sign.
#[utoipa::path(
    post,
    path = "/v1/kv/encrypted/prepare-decrypt",
    tag = "encrypted",
    request_body = PrepareDecryptBody,
    responses(
        (status = 200, description = "Transaction prepared", body = PreparedTransaction),
        (status = 400, description = "Invalid request", body = ErrorResponse),
    )
)]
#[post("/v1/kv/encrypted/prepare-decrypt")]
pub async fn encrypted_prepare_decrypt_handler(
    body: web::Json<PrepareDecryptBody>,
) -> HttpResponse {
    let group_id = body
        .group_id
        .clone()
        .unwrap_or_else(|| format!("{}/private", body.account_id));

    // Validate
    if let Err(e) = validate_account_id(&body.account_id, "account_id") {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: e.to_string(),
            code: e.code(),
        });
    }

    // Parse encrypted value format
    let parts: Vec<&str> = body.ciphertext.split(':').collect();
    let ciphertext_b64 = if parts.len() == 4 && parts[0] == "enc" && parts[1] == "AES256" {
        parts[3].to_string()
    } else {
        body.ciphertext.clone()
    };

    // Build OutLayer request
    let input_data = serde_json::json!({
        "action": "decrypt",
        "group_id": group_id,
        "account_id": body.account_id,
        "ciphertext_b64": ciphertext_b64,
    });

    // Build NEAR transaction args
    let tx_args = serde_json::json!({
        "source": {
            "WasmUrl": {
                "url": KEY_MANAGER_WASM,
                "hash": KEY_MANAGER_HASH,
                "build_target": "wasm32-wasip1"
            }
        },
        "input_data": serde_json::to_string(&input_data).unwrap_or_default(),
        "resource_limits": {
            "max_instructions": "10000000000",
            "max_memory_mb": 128,
            "max_execution_seconds": 60
        },
        "response_format": "Json"
    });

    let args_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        serde_json::to_vec(&tx_args).unwrap_or_default()
    );

    HttpResponse::Ok().json(PreparedTransaction {
        transaction: NearTransactionJson {
            receiver_id: OUTLAYER_CONTRACT.to_string(),
            method_name: "request_execution".to_string(),
            args: args_b64,
            deposit: "50000000000000000000000".to_string(), // 0.05 NEAR
            gas: "300000000000000".to_string(),
        },
        submit_url: "https://wallet.near.org/sign".to_string(),
        instructions: "Sign this transaction with your NEAR wallet. Cost: ~0.05 NEAR".to_string(),
    })
}

/// Get transaction result
///
/// Fetches the result of a signed and submitted transaction.
#[utoipa::path(
    get,
    path = "/v1/kv/encrypted/result",
    tag = "encrypted",
    params(
        ("tx_hash" = String, Path, description = "Transaction hash")
    ),
    responses(
        (status = 200, description = "Transaction result", body = TransactionResult),
        (status = 400, description = "Invalid request", body = ErrorResponse),
    )
)]
#[get("/v1/kv/encrypted/result")]
pub async fn encrypted_result_handler(
    query: web::Query<ResultQuery>,
) -> HttpResponse {
    // Query NEAR RPC for transaction result
    let client = reqwest::Client::new();
    
    let rpc_request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "dontcare",
        "method": "tx",
        "params": [query.tx_hash, "kampouse.near"] // signer account for tx lookup
    });

    let response = match client
        .post("https://rpc.mainnet.near.org")
        .json(&rpc_request)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError().json(ErrorResponse {
                error: format!("RPC error: {}", e),
                code: ErrorCode::DatabaseUnavailable,
            });
        }
    };

    let result: serde_json::Value = match response.json().await {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: format!("Invalid RPC response: {}", e),
                code: ErrorCode::InvalidParameter,
            });
        }
    };

    // Check for transaction status
    if let Some(error) = result.get("error") {
        return HttpResponse::Ok().json(TransactionResult {
            success: false,
            result: None,
            error: Some(error.to_string()),
        });
    }

    // Extract result from transaction receipts
    if let Some(outcome) = result.get("result").and_then(|r| r.get("receipts_outcome")).and_then(|r| r.as_array()).and_then(|a| a.first()) {
        if let Some(logs) = outcome.get("outcome").and_then(|o| o.get("logs")).and_then(|l| l.as_array()) {
            // Look for JSON result in logs
            for log in logs {
                if let Some(log_str) = log.as_str() {
                    if log_str.starts_with("{\"") {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(log_str) {
                            // Check if it's an encrypt/decrypt result
                            if parsed.get("ciphertext_b64").is_some() || parsed.get("plaintext_b64").is_some() {
                                let key_id = parsed.get("key_id").and_then(|k| k.as_str()).unwrap_or("");
                                
                                if let Some(ct) = parsed.get("ciphertext_b64").and_then(|c| c.as_str()) {
                                    return HttpResponse::Ok().json(TransactionResult {
                                        success: true,
                                        result: Some(serde_json::json!({
                                            "encrypted_value": format!("enc:AES256:{}:{}", key_id, ct),
                                            "key_id": key_id,
                                            "attestation": parsed.get("attestation_hash")
                                        })),
                                        error: None,
                                    });
                                }
                                
                                if let Some(pt) = parsed.get("plaintext_utf8").and_then(|p| p.as_str()) {
                                    return HttpResponse::Ok().json(TransactionResult {
                                        success: true,
                                        result: Some(serde_json::json!({
                                            "plaintext": pt,
                                            "key_id": key_id,
                                        })),
                                        error: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    HttpResponse::Ok().json(TransactionResult {
        success: true,
        result: result.get("result").cloned(),
        error: None,
    })
}
