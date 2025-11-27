import { diffChars } from 'diff';

interface CorrectionIssue {
  type: 'typo' | 'tone' | 'politeness' | 'grammar' | 'style';
  original: string;
  corrected: string;
  reason: string;
  severity: number;
}

interface CorrectionResult {
  score: number;
  issues: CorrectionIssue[];
  correctedText: string;
  needsCorrection: boolean;
}

interface ChromeRuntimeMessage {
  action: string;
  text?: string;
}

interface ChromeRuntimeResponse {
  success: boolean;
  data?: {
    issues: CorrectionIssue[];
    correctedText: string;
  };
  error?: string;
}

class SlackMessageCorrector {
  private correctionThreshold: number;
  private isExecutingOriginalSend: boolean;
  private diffLibLoaded: boolean;
  private currentIndicator: HTMLElement | null = null;
  private currentOverlay: HTMLElement | null = null;

  constructor() {
    this.correctionThreshold = 0.3;
    this.isExecutingOriginalSend = false;
    this.diffLibLoaded = true;
    console.log('🔧 SlackMessageCorrector initialized');
    this.init();
  }

  async loadJsDiff(): Promise<void> {
    // Viteでビルドされているので、jsdiffは既にバンドルされている
    this.diffLibLoaded = true;
    console.log('🔧 jsdiff loaded via bundler');
  }

  init(): void {
    console.log('🔧 Starting initialization...');
    this.interceptSendButtons();
    this.interceptKeyboardShortcuts();
    this.observeNewElements();
    console.log('🔧 Initialization complete');
  }

  interceptSendButtons(): void {
    // 実際のSlack要素に基づくセレクター
    const selectors = [
      '[data-qa="texty_send_button"]',
      '[aria-label="今すぐ送信する"]',
      '[aria-label="Send"]',
      '.c-wysiwyg_container__button--send',
      'button[aria-label*="送信"]',
      'button[aria-label*="Send"]',
      '[data-qa="send_message_button"]'
    ];
    
    let allButtons: Element[] = [];
    selectors.forEach(selector => {
      const buttons = document.querySelectorAll(selector);
      console.log(`🔧 Selector "${selector}": ${buttons.length} buttons`);
      allButtons.push(...Array.from(buttons));
    });
    
    // 重複を除去
    const uniqueButtons = [...new Set(allButtons)] as HTMLButtonElement[];
    console.log(`🔧 Total unique send buttons found: ${uniqueButtons.length}`, uniqueButtons);
    
    uniqueButtons.forEach(button => this.attachSendHandler(button));
  }

  interceptKeyboardShortcuts(): void {
    console.log('🔧 Setting up keyboard shortcut interception');
    
    // メッセージ入力エリアでのキーイベントをキャプチャ
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ctrl+Enter または Cmd+Enter (Mac)
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        console.log('🔧 Keyboard shortcut detected: Ctrl/Cmd+Enter');
        
        // 元の送信実行中の場合はスキップ
        if (this.isExecutingOriginalSend) {
          console.log('🔧 Original send in progress, skipping interception');
          return;
        }
        
        // アクティブな要素がメッセージ入力エリアかチェック
        const activeElement = document.activeElement as HTMLElement;
        if (this.isMessageInput(activeElement)) {
          console.log('🔧 Active element is message input, intercepting');
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          
          this.handleKeyboardSend(activeElement);
        }
      }
    }, true); // capture phase で早期にキャプチャ
  }

  isMessageInput(element: HTMLElement | null): boolean {
    return element !== null && (
      element.matches('.ql-editor[data-qa="message_input"]') ||
      element.matches('.ql-editor') ||
      element.closest('[data-qa="message_input"]') !== null ||
      element.closest('.p-message_pane_input') !== null
    );
  }

  async handleKeyboardSend(inputElement: HTMLElement): Promise<void> {
    console.log('🔧 handleKeyboardSend called');
    
    const originalText = this.getMessageText(inputElement);
    console.log('🔧 Keyboard send text:', originalText);
    
    if (!originalText.trim()) {
      console.log('🔧 Empty text, executing original keyboard send');
      this.executeOriginalKeyboardSend(inputElement);
      return;
    }

    // ローディングインジケーターを表示
    this.showLoadingIndicator(inputElement);

    try {
      const corrections = await this.analyzeText(originalText);
      console.log('🔧 Keyboard corrections:', corrections);
      
      this.hideLoadingIndicator();
      
      if (corrections.score >= this.correctionThreshold) {
        console.log('🔧 Showing correction dialog for keyboard send');
        this.showCorrectionDialog(originalText, corrections, null, inputElement);
      } else {
        console.log('🔧 No corrections needed, executing original keyboard send');
        this.executeOriginalKeyboardSend(inputElement);
      }
    } catch (error) {
      console.error('🔧 Error during analysis:', error);
      this.hideLoadingIndicator();
      this.executeOriginalKeyboardSend(inputElement);
    }
  }

  executeOriginalKeyboardSend(inputElement: HTMLElement): void {
    console.log('🔧 Executing original keyboard send');
    
    // 送信ボタンが有効になるまで待つ
    this.waitForSendButton().then(sendButton => {
      if (sendButton) {
        console.log('🔧 Clicking send button directly');
        
        // 送信中フラグを設定
        sendButton.dataset.correctorSending = 'true';
        
        setTimeout(() => {
          sendButton.click();
          
          setTimeout(() => {
            sendButton.dataset.correctorSending = 'false';
          }, 100);
        }, 10);
      } else {
        console.log('🔧 Send button not available, falling back to keyboard event');
        
        // フラグを設定して無限ループを防ぐ
        this.isExecutingOriginalSend = true;
        
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        });
        
        setTimeout(() => {
          inputElement.dispatchEvent(event);
          
          setTimeout(() => {
            this.isExecutingOriginalSend = false;
          }, 100);
        }, 10);
      }
    });
  }

  waitForSendButton(maxAttempts = 10, interval = 100): Promise<HTMLButtonElement | null> {
    return new Promise((resolve) => {
      let attempts = 0;
      
      const checkButton = () => {
        const sendButton = document.querySelector('[data-qa="texty_send_button"]') as HTMLButtonElement;
        const isEnabled = sendButton && 
                         !sendButton.disabled && 
                         sendButton.getAttribute('aria-disabled') !== 'true';
        
        console.log(`🔧 Attempt ${attempts + 1}: Button enabled = ${isEnabled}`);
        
        if (isEnabled) {
          resolve(sendButton);
        } else if (attempts < maxAttempts) {
          attempts++;
          setTimeout(checkButton, interval);
        } else {
          console.log('🔧 Max attempts reached, button still not enabled');
          resolve(null);
        }
      };
      
      checkButton();
    });
  }

  findAndAttachButtons(container: Document | Element = document): void {
    const selectors = [
      '[data-qa="texty_send_button"]',
      '[aria-label="今すぐ送信する"]',
      '[aria-label="Send"]',
      '.c-wysiwyg_container__button--send',
      'button[aria-label*="送信"]',
      'button[aria-label*="Send"]',
      '[data-qa="send_message_button"]'
    ];
    
    let allButtons: Element[] = [];
    selectors.forEach(selector => {
      const buttons = container.querySelectorAll(selector);
      allButtons.push(...Array.from(buttons));
    });
    
    const uniqueButtons = [...new Set(allButtons)] as HTMLButtonElement[];
    uniqueButtons.forEach(button => this.attachSendHandler(button));
  }

  observeNewElements(): void {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        // 新しい要素が追加された場合
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            this.findAndAttachButtons(node as Element);
          }
        });
        
        // 属性が変更された場合（ボタンの状態変更を検出）
        if (mutation.type === 'attributes' && (mutation.target as Element).matches('[data-qa="texty_send_button"]')) {
          console.log('🔧 Send button attributes changed, re-attaching handler');
          this.attachSendHandler(mutation.target as HTMLButtonElement);
        }
      });
    });
    
    observer.observe(document.body, { 
      childList: true, 
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-disabled', 'disabled', 'class']
    });
  }

  attachSendHandler(button: HTMLButtonElement): void {
    if ((button as any).dataset.correctorAttached) return;
    (button as any).dataset.correctorAttached = 'true';
    console.log('🔧 Attached handler to button:', button);
    
    button.addEventListener('click', (e: Event) => {
      console.log('🔧 Send button clicked!', e);
      
      // 送信中の場合は処理をスキップ
      if ((button as any).dataset.correctorSending === 'true') {
        console.log('🔧 Button is sending, skipping interception');
        return;
      }
      
      e.preventDefault();
      e.stopPropagation();
      this.handleSendClick(button);
    }, true);
  }

  async handleSendClick(button: HTMLButtonElement): Promise<void> {
    console.log('🔧 handleSendClick called');
    const messageInput = this.findMessageInput(button);
    console.log('🔧 Found message input:', messageInput);
    
    if (!messageInput) {
      console.log('🔧 No message input found, sending original');
      return;
    }

    const originalText = this.getMessageText(messageInput);
    console.log('🔧 Original text:', originalText);
    
    if (!originalText.trim()) {
      console.log('🔧 Empty text, sending original');
      this.sendOriginalMessage(button);
      return;
    }

    // ローディングインジケーターを表示
    this.showLoadingIndicator(messageInput);
    this.showButtonLoading(button);

    try {
      const corrections = await this.analyzeText(originalText);
      console.log('🔧 Corrections:', corrections);
      
      this.hideLoadingIndicator();
      this.hideButtonLoading(button);
      
      if (corrections.score >= this.correctionThreshold) {
        console.log('🔧 Showing correction dialog');
        this.showCorrectionDialog(originalText, corrections, button, messageInput);
      } else {
        console.log('🔧 No corrections needed, sending original');
        this.sendOriginalMessage(button);
      }
    } catch (error) {
      console.error('🔧 Error during analysis:', error);
      this.hideLoadingIndicator();
      this.hideButtonLoading(button);
      this.sendOriginalMessage(button);
    }
  }

  findMessageInput(button: HTMLButtonElement): HTMLElement | null {
    // 実際のSlack要素に基づく検索
    const container = button.closest('.p-message_pane_input') || 
                     button.closest('.c-wysiwyg_container') ||
                     button.closest('[data-qa="message_input_container"]');
    
    if (container) {
      return container.querySelector('.ql-editor[data-qa="message_input"]') as HTMLElement || 
             container.querySelector('.ql-editor') as HTMLElement ||
             container.querySelector('[role="textbox"]') as HTMLElement ||
             container as HTMLElement;
    }
    
    return document.querySelector('.ql-editor[data-qa="message_input"]') as HTMLElement ||
           document.querySelector('.ql-editor') as HTMLElement ||
           document.querySelector('[role="textbox"]') as HTMLElement;
  }

  getMessageText(input: HTMLElement): string {
    if (input.classList.contains('ql-editor')) {
      return input.innerText || input.textContent || '';
    }
    return (input as HTMLInputElement).value || input.innerText || input.textContent || '';
  }

  setMessageText(input: HTMLElement, text: string): void {
    console.log('🔧 Setting message text:', text);
    console.log('🔧 Input element:', input);
    
    if (input.classList.contains('ql-editor')) {
      // Quill エディター用の処理
      input.innerText = text;
      
      // 複数のイベントを発火してSlackに確実に認識させる
      const events = [
        new Event('input', { bubbles: true }),
        new Event('keyup', { bubbles: true }),
        new Event('change', { bubbles: true }),
        new InputEvent('input', { 
          bubbles: true, 
          cancelable: true,
          inputType: 'insertText',
          data: text
        })
      ];
      
      events.forEach(event => {
        input.dispatchEvent(event);
      });
      
      // フォーカスを当て直してSlackの状態を更新
      input.focus();
      
    } else {
      (input as HTMLInputElement).value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // 少し待ってから送信ボタンの状態をチェック
    setTimeout(() => {
      const sendButton = document.querySelector('[data-qa="texty_send_button"]') as HTMLButtonElement;
      console.log('🔧 Send button after text update:', sendButton);
      console.log('🔧 Send button disabled:', sendButton?.disabled);
      console.log('🔧 Send button aria-disabled:', sendButton?.getAttribute('aria-disabled'));
    }, 100);
  }

  async analyzeText(text: string): Promise<CorrectionResult> {
    try {
      // Chrome runtime messaging with proper typing
      const response = await chrome.runtime.sendMessage({
        action: 'correctText',
        text: text
      } as ChromeRuntimeMessage) as ChromeRuntimeResponse;

      if (response.success && response.data) {
        const data = response.data;
        
        // 重要度の低い修正を除外（0.3以下は表示しない）
        const significantIssues = data.issues.filter(issue => issue.severity > 0.3);
        
        // 除外によって修正がなくなった場合
        const hasSignificantIssues = significantIssues.length > 0;
        const adjustedScore = hasSignificantIssues ? Math.max(...significantIssues.map(i => i.severity)) : 0;
        
        return {
          score: adjustedScore,
          issues: significantIssues,
          correctedText: data.correctedText,
          needsCorrection: hasSignificantIssues && adjustedScore >= this.correctionThreshold
        };
      } else {
        console.error('Claude API Error:', response.error);
        // フォールバック：ローカルパターンマッチ
        return this.analyzeTextFallback(text);
      }
    } catch (error) {
      console.error('Analysis error:', error);
      // フォールバック：ローカルパターンマッチ
      return this.analyzeTextFallback(text);
    }
  }

  analyzeTextFallback(text: string): CorrectionResult {
    return {
      score: 0.0,
      issues: [],
      correctedText: text,
      needsCorrection: false
    };
  }

  showCorrectionDialog(originalText: string, corrections: CorrectionResult, button: HTMLButtonElement | null, messageInput: HTMLElement): void {
    const dialog = this.createCorrectionDialog(originalText, corrections);
    document.body.appendChild(dialog);

    const userTextArea = dialog.querySelector('.user-edit-area') as HTMLTextAreaElement;
    const sendBtn = dialog.querySelector('.send-corrected') as HTMLButtonElement;
    const skipBtn = dialog.querySelector('.send-original') as HTMLButtonElement;
    const reCorrectBtn = dialog.querySelector('.re-correct') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('.close-dialog') as HTMLButtonElement;
    const diffDisplay = dialog.querySelector('.diff-display') as HTMLElement;

    // 初期テキストを元のテキストに設定
    userTextArea.value = originalText;
    this.updateDiffDisplay(userTextArea, corrections.correctedText, diffDisplay, sendBtn);

    // リアルタイム差分表示
    userTextArea.addEventListener('input', () => {
      this.updateDiffDisplay(userTextArea, corrections.correctedText, diffDisplay, sendBtn);
    });

    // 送信ボタン（想定文と一致した場合のみ有効）
    sendBtn.onclick = () => {
      console.log('🔧 Sending user corrected text');
      // 末尾スペースを除去した正規化テキストを送信
      const normalizedText = userTextArea.value.trimEnd();
      this.setMessageText(messageInput, normalizedText);
      dialog.remove();
      
      setTimeout(() => {
        if (button) {
          this.sendOriginalMessage(button);
        } else {
          this.executeOriginalKeyboardSend(messageInput);
        }
      }, 200);
    };

    // このまま送信（現在編集中のテキストを送信）
    skipBtn.onclick = () => {
      console.log('🔧 Sending currently edited text');
      const currentText = userTextArea.value;
      this.setMessageText(messageInput, currentText);
      dialog.remove();
      
      setTimeout(() => {
        if (button) {
          this.sendOriginalMessage(button);
        } else {
          this.executeOriginalKeyboardSend(messageInput);
        }
      }, 200);
    };

    // 再校正ボタン
    reCorrectBtn.onclick = async (e: Event) => {
      console.log('🔧 Re-correcting text');
      const currentText = userTextArea.value.trim();
      
      if (!currentText) {
        alert('テキストを入力してください');
        return;
      }
      
      // ローディング状態を表示
      reCorrectBtn.disabled = true;
      reCorrectBtn.textContent = '校正中...';
      
      try {
        const newCorrections = await this.analyzeText(currentText);
        console.log('🔧 Re-correction results:', newCorrections);
        
        // 新しい校正結果でダイアログを更新
        this.updateCorrectionDialog(dialog, currentText, newCorrections, diffDisplay, sendBtn);
        
      } catch (error) {
        console.error('🔧 Re-correction error:', error);
        alert('再校正中にエラーが発生しました');
      } finally {
        reCorrectBtn.disabled = false;
        reCorrectBtn.textContent = '再校正';
      }
    };

    closeBtn.onclick = () => {
      dialog.remove();
    };

    // フォーカスをテキストエリアに
    setTimeout(() => userTextArea.focus(), 100);
  }

  createCorrectionDialog(originalText: string, corrections: CorrectionResult): HTMLElement {
    const dialog = document.createElement('div');
    dialog.className = 'slack-corrector-dialog';
    
    const getIssueTypeName = (type: string): string => {
      const typeNames: Record<string, string> = {
        typo: '誤字',
        tone: 'トーン',
        politeness: '敬語',
        grammar: '文法',
        style: 'スタイル'
      };
      return typeNames[type] || '修正';
    };

    const issuesList = corrections.issues.map(issue => 
      `<li class="issue-${issue.type}">
        <strong>${getIssueTypeName(issue.type)}</strong>: "${issue.original}" → "${issue.corrected}"
        ${issue.reason ? `<br><small class="issue-reason">理由: ${issue.reason}</small>` : ''}
        <br><small class="issue-severity">重要度: ${Math.round(issue.severity * 100)}%</small>
      </li>`
    ).join('');

    const issuesSection = corrections.issues.length > 0 ? 
      `<div class="issues-section">
        <h4>検出された問題:</h4>
        <p class="issues-filter-note">※重要度30%未満の軽微な修正は表示していません</p>
        <ul class="issues-list">${issuesList}</ul>
      </div>` :
      `<div class="issues-section">
        <h4>検出された問題:</h4>
        <p class="no-significant-issues">重要度の高い問題は検出されませんでした</p>
      </div>`;

    dialog.innerHTML = `
      <div class="dialog-content">
        <div class="dialog-header">
          <h3>メッセージ校正</h3>
          <button class="close-dialog">×</button>
        </div>
        
        <div class="dialog-body">
          <div class="correction-score">
            校正スコア: ${(corrections.score * 100).toFixed(0)}%
          </div>
          
          ${issuesSection}
          
          <div class="edit-section">
            <div class="target-text">
              <h4>目標文:</h4>
              <div class="text-content target">${corrections.correctedText}</div>
            </div>
            
            <div class="user-edit">
              <h4>修正してください:</h4>
              <textarea class="user-edit-area" placeholder="ここでメッセージを修正してください..."></textarea>
            </div>
            
            <div class="diff-section">
              <h4>差分:</h4>
              <p class="diff-help">※末尾のスペースは自動的に無視されます</p>
              <div class="diff-display"></div>
            </div>
          </div>
        </div>
        
        <div class="dialog-footer">
          <button class="send-original">このまま送信</button>
          <button class="re-correct">再校正</button>
          <button class="send-corrected" disabled>修正版を送信</button>
        </div>
      </div>
    `;
    
    return dialog;
  }

  updateDiffDisplay(userTextArea: HTMLTextAreaElement, expectedText: string, diffDisplay: HTMLElement, sendBtn: HTMLButtonElement): void {
    const userText = userTextArea.value;
    
    // 末尾スペースを無視した比較
    const normalizedUserText = userText.trimEnd();
    const normalizedExpectedText = expectedText.trimEnd();
    const isMatch = normalizedUserText === normalizedExpectedText;
    
    // 送信ボタンの有効/無効制御
    sendBtn.disabled = !isMatch;
    if (isMatch) {
      sendBtn.classList.add('enabled');
      sendBtn.textContent = '✓ 修正版を送信';
    } else {
      sendBtn.classList.remove('enabled');
      sendBtn.textContent = '修正版を送信（要修正）';
    }
    
    // 差分表示の更新
    if (normalizedUserText === '') {
      diffDisplay.innerHTML = '<span class="diff-empty">テキストを入力してください</span>';
      return;
    }
    
    if (isMatch) {
      diffDisplay.innerHTML = '<span class="diff-perfect">✓ 完璧です！</span>';
      return;
    }
    
    // 正規化されたテキストで差分を計算（末尾スペースを除去）
    const diff = this.calculateDiff(normalizedUserText, normalizedExpectedText);
    diffDisplay.innerHTML = diff;
  }

  calculateDiff(userText: string, expectedText: string): string {
    // 簡単なケースの処理
    if (userText === expectedText) {
      return userText;
    }
    
    if (userText === '') {
      return `<span class="diff-missing">${this.escapeHtml(expectedText)}</span>`;
    }
    
    if (expectedText === '') {
      return `<span class="diff-extra">${this.escapeHtml(userText)}</span>`;
    }

    // jsdiffを使用した差分計算
    return this.calculateDiffWithJsDiff(userText, expectedText);
  }

  calculateDiffWithJsDiff(userText: string, expectedText: string): string {
    const diff = diffChars(userText, expectedText);
    let result = '';
    
    diff.forEach(part => {
      const value = this.escapeHtml(part.value || '');
      if (part.added) {
        // 期待されるテキストに追加された部分（ユーザーが入力すべき部分）
        result += `<span class="diff-missing">${value}</span>`;
      } else if (part.removed) {
        // ユーザーテキストから削除された部分（余分な部分）
        result += `<span class="diff-extra">${value}</span>`;
      } else {
        // 共通部分
        result += value;
      }
    });
    
    return result || '<span class="diff-empty">空です</span>';
  }

  calculateDiffFallback(userText: string, expectedText: string): string {
    // シンプルなフォールバック実装
    const minLength = Math.min(userText.length, expectedText.length);
    let result = '';
    let i = 0;
    
    // 共通プレフィックスを見つける
    while (i < minLength && userText[i] === expectedText[i]) {
      result += this.escapeHtml(userText[i]);
      i++;
    }
    
    // 残りの部分を処理
    if (i < userText.length) {
      result += `<span class="diff-extra">${this.escapeHtml(userText.slice(i))}</span>`;
    }
    if (i < expectedText.length) {
      result += `<span class="diff-missing">${this.escapeHtml(expectedText.slice(i))}</span>`;
    }
    
    return result || '<span class="diff-empty">空です</span>';
  }

  escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  updateCorrectionDialog(dialog: HTMLElement, newOriginalText: string, newCorrections: CorrectionResult, diffDisplay: HTMLElement, sendBtn: HTMLButtonElement): void {
    console.log('🔧 Updating correction dialog with new results');
    
    // 校正スコアを更新
    const scoreElement = dialog.querySelector('.correction-score');
    if (scoreElement) {
      scoreElement.textContent = `校正スコア: ${(newCorrections.score * 100).toFixed(0)}%`;
    }
    
    // 問題リストを更新
    const issuesSection = dialog.querySelector('.issues-section');
    if (issuesSection) {
      const getIssueTypeName = (type: string): string => {
        const typeNames: Record<string, string> = {
          typo: '誤字',
          tone: 'トーン',
          politeness: '敬語',
          grammar: '文法',
          style: 'スタイル'
        };
        return typeNames[type] || '修正';
      };

      const issuesList = newCorrections.issues.map(issue => 
        `<li class="issue-${issue.type}">
          <strong>${getIssueTypeName(issue.type)}</strong>: "${issue.original}" → "${issue.corrected}"
          ${issue.reason ? `<br><small class="issue-reason">理由: ${issue.reason}</small>` : ''}
          <br><small class="issue-severity">重要度: ${Math.round(issue.severity * 100)}%</small>
        </li>`
      ).join('');

      const newIssuesContent = newCorrections.issues.length > 0 ? 
        `<h4>検出された問題:</h4>
        <p class="issues-filter-note">※重要度30%未満の軽微な修正は表示していません</p>
        <ul class="issues-list">${issuesList}</ul>` :
        `<h4>検出された問題:</h4>
        <p class="no-significant-issues">重要度の高い問題は検出されませんでした</p>`;
      
      issuesSection.innerHTML = newIssuesContent;
    }
    
    // 目標文を更新
    const targetTextElement = dialog.querySelector('.text-content.target');
    if (targetTextElement) {
      targetTextElement.textContent = newCorrections.correctedText;
    }
    
    // ユーザー編集エリアのテキストはそのまま保持（現在編集中のテキストを維持）
    
    // 差分表示を更新
    const userTextArea = dialog.querySelector('.user-edit-area') as HTMLTextAreaElement;
    this.updateDiffDisplay(userTextArea, newCorrections.correctedText, diffDisplay, sendBtn);
  }

  showLoadingIndicator(inputElement: HTMLElement): void {
    // 既存のインジケーターを削除
    this.hideLoadingIndicator();
    
    const container = inputElement.closest('.p-message_pane_input') as HTMLElement || 
                     inputElement.closest('.c-wysiwyg_container') as HTMLElement ||
                     inputElement.parentElement;
    
    if (!container) return;
    
    // コンテナを相対位置に設定
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    
    // インジケーターを作成
    const indicator = document.createElement('div');
    indicator.className = 'ai-correction-indicator';
    indicator.innerHTML = `
      <div class="spinner"></div>
      <span>AI校正中...</span>
    `;
    
    // オーバーレイを作成
    const overlay = document.createElement('div');
    overlay.className = 'ai-correction-overlay';
    
    // 要素を追加
    container.appendChild(indicator);
    container.appendChild(overlay);
    
    // 参照を保存
    this.currentIndicator = indicator;
    this.currentOverlay = overlay;
  }
  
  hideLoadingIndicator(): void {
    if (this.currentIndicator) {
      this.currentIndicator.remove();
      this.currentIndicator = null;
    }
    if (this.currentOverlay) {
      this.currentOverlay.remove();
      this.currentOverlay = null;
    }
  }
  
  showButtonLoading(button: HTMLButtonElement): void {
    if (button) {
      button.classList.add('send-button-loading');
      (button as any).dataset.originalText = button.textContent;
    }
  }
  
  hideButtonLoading(button: HTMLButtonElement): void {
    if (button) {
      button.classList.remove('send-button-loading');
      if ((button as any).dataset.originalText) {
        button.textContent = (button as any).dataset.originalText;
        delete (button as any).dataset.originalText;
      }
    }
  }

  sendOriginalMessage(button: HTMLButtonElement): void {
    console.log('🔧 Sending original message via button');
    
    // 送信ボタンが有効になるまで待つ
    this.waitForSendButton().then(sendButton => {
      if (sendButton) {
        // ハンドラーを一時的に無効化
        (sendButton as any).dataset.correctorSending = 'true';
        
        // 少し待ってからクリック（Slackの処理を待つ）
        setTimeout(() => {
          sendButton.click();
          
          // 送信後にハンドラーを再有効化
          setTimeout(() => {
            (sendButton as any).dataset.correctorSending = 'false';
          }, 100);
        }, 10);
      } else {
        console.log('🔧 Send button not available for original message');
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SlackMessageCorrector();
  });
} else {
  new SlackMessageCorrector();
}