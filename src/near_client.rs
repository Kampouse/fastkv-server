use std::sync::Arc;

use near_api::types::transaction::actions::{Action, FunctionCallAction};
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, SecretKey, Signer, Transaction};

pub struct NearClient {
    contract_id: AccountId,
    account_id: AccountId,
    signer: Arc<Signer>,
    network: NetworkConfig,
}

impl NearClient {
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let account_id_str = match std::env::var("NEAR_ACCOUNT_ID") {
            Ok(id) => id,
            Err(_) => {
                tracing::info!(target: "fastkv-server", "NEAR_ACCOUNT_ID not set, commit endpoint disabled");
                return Ok(None);
            }
        };

        let secret_key_str = std::env::var("NEAR_SECRET_KEY")
            .map_err(|_| anyhow::anyhow!("NEAR_SECRET_KEY required when NEAR_ACCOUNT_ID is set"))?;
        let contract_id_str = std::env::var("NEAR_CONTRACT_ID")
            .map_err(|_| anyhow::anyhow!("NEAR_CONTRACT_ID required when NEAR_ACCOUNT_ID is set"))?;
        let network_name = std::env::var("NEAR_NETWORK").unwrap_or_else(|_| "testnet".to_string());

        let account_id: AccountId = account_id_str.parse()
            .map_err(|e| anyhow::anyhow!("Invalid NEAR_ACCOUNT_ID: {}", e))?;
        let contract_id: AccountId = contract_id_str.parse()
            .map_err(|e| anyhow::anyhow!("Invalid NEAR_CONTRACT_ID: {}", e))?;
        let secret_key: SecretKey = secret_key_str.parse()
            .map_err(|e| anyhow::anyhow!("Invalid NEAR_SECRET_KEY: {}", e))?;

        let signer = Signer::from_secret_key(secret_key)
            .map_err(|e| anyhow::anyhow!("Failed to create signer: {}", e))?;

        let network = match network_name.as_str() {
            "mainnet" => NetworkConfig::mainnet(),
            "testnet" => NetworkConfig::testnet(),
            other => anyhow::bail!("Unsupported NEAR_NETWORK: {}", other),
        };

        tracing::info!(
            target: "fastkv-server",
            account_id = %account_id,
            contract_id = %contract_id,
            network = %network_name,
            "NEAR client initialized"
        );

        Ok(Some(Self {
            contract_id,
            account_id,
            signer,
            network,
        }))
    }

    pub async fn commit_batch(&self, items: Vec<(String, String)>) -> anyhow::Result<String> {
        if items.is_empty() {
            anyhow::bail!("Cannot commit empty batch");
        }

        let actions: Vec<Action> = items
            .into_iter()
            .map(|(key, value)| {
                Action::FunctionCall(Box::new(FunctionCallAction {
                    method_name: "__fastdata_kv".to_string(),
                    args: serde_json::json!({"key": key, "value": value})
                        .to_string()
                        .into_bytes(),
                    gas: NearGas::from_tgas(30),
                    deposit: NearToken::from_yoctonear(0),
                }))
            })
            .collect();

        let result = Transaction::construct(self.account_id.clone(), self.contract_id.clone())
            .add_actions(actions)
            .with_signer(self.signer.clone())
            .send_to(&self.network)
            .await
            .map_err(|e| anyhow::anyhow!("NEAR batch transaction failed: {}", e))?;

        let tx_hash = result.outcome().transaction_hash.to_string();
        if result.is_failure() {
            anyhow::bail!("Batch transaction failed: {:?}", result);
        }
        Ok(tx_hash)
    }
}
