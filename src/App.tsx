import { useState, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Upload, FileText, Image as ImageIcon, Loader2, AlertCircle, CheckCircle2, Database } from 'lucide-react';

const SYSTEM_PROMPT = `## 角色設定
你是一位資深資管系統架構師。任務是將「食譜照片」中的內容，根據使用者輸入的「資料來源」，轉換為 PostgreSQL 批量寫入指令。

## 任務規範
1. 視覺掃描：讀取【食譜照片】欄位中的圖片。單切水果請視為「切片XX」點心。
2. 資源溯源：檢查使用者傳送的文字。若有打字，作為 resource 寫入；若完全沒打字，預設填「新北市政府衛生局銀髮族糖尿病食譜」。
3. 【重點更新】數據對接 (強制轉譯邏輯)：
   - 資料庫的 categories 只有三種：'早餐', '午晚餐', '點心'。
   - 若圖片顯示為「主食」、「午餐」、「晚餐」、「正餐」或類似主菜類別，請一律強制對應並寫入 '午晚餐'。
   - 若圖片顯示為「水果」、「甜湯」、「飲品」，請一律強制對應並寫入 '點心'。
4. 動態關聯 (Dynamic Link)：絕對不要手動指定任何 id。請完全依賴 \`SERIAL\` 自動遞增，並使用 \`(SELECT id FROM recipes WHERE title = '該道菜名')\` 來關聯副表。
5. 月份判斷：若為季節性水果，請在 ingredients 的 start_month 與 end_month 填入產季數字；其餘填 NULL。
6. 【重要】數量轉譯 (Quantity Conversion)：
   - recipe_ingredients 表的 quantity 欄位必須為純數字 (NUMERIC)。
   - 若圖片中的數量為分數 (如 1/2, 1/3, 1/4) 或中文字 (如 半匙)，請務必強制計算並轉換為小數點 (如 0.5, 0.33, 0.25)，絕對禁止輸出 '1/2' 這種字串。
7. 輸出限制：僅輸出純 SQL 代碼塊，嚴禁 Markdown 標籤 (不要輸出 \`\`\`sql)。

## SQL 結構與生成規則 (以「牛肉捲」為例)
請嚴格使用以下語法結構，並確保每一次都使用 \`(SELECT id FROM ...)\` 進行精準關聯：

-- 1. 新增食譜主表 (省略 id，讓資料庫自動生成)
INSERT INTO recipes (title, servings, category_id, resource) VALUES
('牛肉捲', 1, (SELECT id FROM categories WHERE name = '午晚餐'), '資料來源');

-- 2. 新增食材字典
INSERT INTO ingredients (name, start_month, end_month) VALUES 
('牛肉片', NULL, NULL), ('蘆筍', NULL, NULL) ON CONFLICT (name) DO NOTHING;

-- 3. 新增食譜食材關聯 (透過菜名與食材名動態抓取 ID)
INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity, unit, type) VALUES
((SELECT id FROM recipes WHERE title = '牛肉捲'), (SELECT id FROM ingredients WHERE name = '牛肉片'), 200, '克', '材料');

-- 4. 新增步驟
INSERT INTO recipe_steps (recipe_id, step_number, instruction) VALUES
((SELECT id FROM recipes WHERE title = '牛肉捲'), 1, '步驟內容...');

-- 5. 新增健康評估
INSERT INTO recipe_health_evaluations (recipe_id, disease_name, suitability, reason) VALUES
((SELECT id FROM recipes WHERE title = '牛肉捲'), '糖尿病', '適合', '原因...');`;

async function fileToGenerativePart(file: File) {
  const base64EncodedDataPromise = new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
  return {
    inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
  };
}

export default function App() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [customResource, setCustomResource] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [outputSql, setOutputSql] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setPdfFiles(Array.from(e.target.files));
    }
  };

  const handleGenerate = async () => {
    if (!imageFile) {
      setError('請先上傳食譜照片');
      return;
    }
    
    setError(null);
    setIsGenerating(true);
    setOutputSql('');

    try {
      // Initialize Gemini API
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const parts: any[] = [
        { text: SYSTEM_PROMPT }
      ];

      // Add Image
      const imagePart = await fileToGenerativePart(imageFile);
      parts.push(imagePart);

      // Add PDFs if provided
      for (const file of pdfFiles) {
        const pdfPart = await fileToGenerativePart(file);
        parts.push(pdfPart);
      }

      // Add User Prompt
      const userText = customResource.trim() 
        ? `請根據指令分析這張圖中的所有食譜。參考附上的PDF。使用者對話框輸入的資料來源：「${customResource}」`
        : "請根據指令分析這張圖中的所有食譜。參考附上的PDF。使用者未輸入文字，請使用預設 resource 來源設定。";
      parts.push({ text: userText });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: parts,
        config: {
          temperature: 0.2, // Lower temperature for more deterministic output
        }
      });

      let text = response.text || '';
      
      // Clean up markdown formatting if the model accidentally includes it despite instructions
      text = text.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();

      setOutputSql(text);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '生成過程中發生錯誤，請稍後再試。');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans p-6 md:p-12">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="border-b border-gray-200 pb-6">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 flex items-center gap-3">
            <span className="text-4xl">🥗</span> 長輩食譜 SQL 產生器
          </h1>
          <p className="mt-2 text-gray-600">
            上傳食譜照片與相關 PDF (如：糖尿病.pdf、低普林食物選擇表.pdf)，自動解析並生成極致優化的 PostgreSQL 批次寫入語法。
          </p>
        </header>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          {/* Left Column: Inputs */}
          <div className="space-y-6 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            
            {/* Image Upload */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                1. 丟入食譜照片 (必填)
              </label>
              <div 
                onClick={() => imageInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl p-6 transition-colors cursor-pointer text-center
                  ${imagePreview ? 'border-green-400 bg-green-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'}`}
              >
                <input 
                  type="file" 
                  accept="image/*" 
                  className="hidden" 
                  ref={imageInputRef}
                  onChange={handleImageChange}
                />
                {imagePreview ? (
                  <div className="space-y-4">
                    <img src={imagePreview} alt="Preview" className="max-h-48 mx-auto rounded-lg shadow-sm object-contain" />
                    <div className="flex items-center justify-center text-green-700 font-medium gap-2">
                      <CheckCircle2 className="w-5 h-5" /> 已選擇照片
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 py-8">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                    <div className="text-gray-600">點擊或拖曳上傳圖片</div>
                    <div className="text-xs text-gray-400">支援 JPG, PNG 格式</div>
                  </div>
                )}
              </div>
            </div>

            {/* PDF Upload */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                2. 丟入參考文件 PDF (可多選，如：每日建議量.pdf、低普林表.pdf)
              </label>
              <div 
                onClick={() => pdfInputRef.current?.click()}
                className={`relative border-2 border-dashed rounded-xl p-6 transition-colors cursor-pointer text-center
                  ${pdfFiles.length > 0 ? 'border-green-400 bg-green-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'}`}
              >
                <input 
                  type="file" 
                  accept="application/pdf" 
                  className="hidden" 
                  multiple
                  ref={pdfInputRef}
                  onChange={handlePdfChange}
                />
                {pdfFiles.length > 0 ? (
                  <div className="space-y-3 py-4">
                    <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div className="text-green-700 font-medium flex flex-col items-center justify-center gap-1">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5" /> 已選擇 {pdfFiles.length} 個檔案
                      </div>
                      <div className="text-xs font-normal opacity-80 mt-1 space-y-1">
                        {pdfFiles.map((f, i) => (
                          <div key={i}>{f.name}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 py-4">
                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto">
                      <Upload className="w-6 h-6" />
                    </div>
                    <div className="text-gray-600">點擊上傳多個 PDF 文件</div>
                  </div>
                )}
              </div>
            </div>

            {/* Resource Input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                3. 食譜資料來源 (可留空，選填)
              </label>
              <input
                type="text"
                value={customResource}
                onChange={(e) => setCustomResource(e.target.value)}
                placeholder="例如：出自阿基師食譜... (不填則預設為新北市紀錄)"
                className="w-full border-2 border-gray-300 rounded-xl px-4 py-3 focus:border-blue-400 focus:bg-blue-50 focus:ring-0 transition-colors outline-none text-gray-700 font-medium"
              />
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-4 bg-red-50 text-red-700 rounded-xl flex items-start gap-3 border border-red-100">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {/* Submit Button */}
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !imageFile}
              className="w-full py-4 px-6 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-xl font-medium text-lg transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  AI 正在努力撰寫 SQL 中...
                </>
              ) : (
                <>
                  🚀 產生批次 SQL 寫入語法
                </>
              )}
            </button>
          </div>

          {/* Right Column: Output */}
          <div className="bg-gray-900 rounded-2xl shadow-sm border border-gray-800 flex flex-col overflow-hidden h-[600px] lg:h-auto">
            <div className="bg-gray-800 px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <div className="flex gap-4">
                 <div className="text-sm font-medium flex items-center gap-2 text-blue-400">
                  <Database className="w-4 h-4" />
                  SQL 生成結果
                </div>
              </div>
              {outputSql && (
                <button 
                  onClick={() => navigator.clipboard.writeText(outputSql)}
                  className="text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 bg-gray-700 rounded-md"
                >
                  複製代碼
                </button>
              )}
            </div>
            <div className="flex-1 p-4 overflow-auto bg-[#0d1117]">
              {outputSql ? (
                <pre className="text-sm text-blue-400 font-mono whitespace-pre-wrap break-words">
                  {outputSql}
                </pre>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-500 text-sm font-mono">
                  -- 等待生成中...
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
