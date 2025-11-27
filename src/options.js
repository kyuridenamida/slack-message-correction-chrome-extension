// Options page script
document.addEventListener('DOMContentLoaded', function() {
  const apiKeyInput = document.getElementById('apiKey');
  const saveButton = document.getElementById('save');
  const testButton = document.getElementById('test');
  const status = document.getElementById('status');

  // 保存されたAPIキーを読み込み
  loadSavedSettings();

  // 保存ボタンのイベント
  saveButton.addEventListener('click', saveSettings);
  
  // テストボタンのイベント
  testButton.addEventListener('click', testConnection);

  // Enterキーで保存
  apiKeyInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      saveSettings();
    }
  });

  async function loadSavedSettings() {
    try {
      const result = await chrome.storage.local.get(['claudeApiKey']);
      if (result.claudeApiKey) {
        apiKeyInput.value = result.claudeApiKey;
      }
    } catch (error) {
      console.error('設定の読み込みエラー:', error);
    }
  }

  async function saveSettings() {
    const apiKey = apiKeyInput.value.trim();
    
    if (!apiKey) {
      showStatus('APIキーを入力してください', 'error');
      return;
    }

    if (!apiKey.startsWith('sk-ant-')) {
      showStatus('正しいClaude APIキー形式ではありません', 'error');
      return;
    }

    try {
      saveButton.disabled = true;
      await chrome.storage.local.set({ claudeApiKey: apiKey });
      showStatus('設定を保存しました', 'success');
      
      setTimeout(() => {
        saveButton.disabled = false;
      }, 1000);
      
    } catch (error) {
      console.error('設定の保存エラー:', error);
      showStatus('設定の保存に失敗しました', 'error');
      saveButton.disabled = false;
    }
  }

  async function testConnection() {
    const apiKey = apiKeyInput.value.trim();
    
    if (!apiKey) {
      showStatus('APIキーを入力してください', 'error');
      return;
    }

    try {
      testButton.disabled = true;
      testButton.textContent = 'テスト中...';
      
      // テストメッセージを送信
      const response = await chrome.runtime.sendMessage({
        action: 'correctText',
        text: 'こんにちは'
      });

      if (response.success) {
        showStatus('✅ Claude APIとの接続に成功しました', 'success');
      } else {
        showStatus(`❌ 接続テストに失敗: ${response.error}`, 'error');
      }
      
    } catch (error) {
      console.error('接続テストエラー:', error);
      showStatus('❌ 接続テストでエラーが発生しました', 'error');
    } finally {
      testButton.disabled = false;
      testButton.textContent = '接続テスト';
    }
  }

  function showStatus(message, type) {
    status.textContent = message;
    status.className = `status ${type}`;
    status.style.display = 'block';
    
    setTimeout(() => {
      status.style.display = 'none';
    }, 5000);
  }
});