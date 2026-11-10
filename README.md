# 🎮 NỐI TỪ ĐẠI CHIẾN – Tool game cho TikTok Live

Người xem comment từ ghép 2 chữ, bắt đầu bằng chữ cuối của từ trước. **Người đúng sớm nhất thắng**,
avatar + tên hiện ngay trên bảng đáp án, có điểm, combo, bảng vàng, **giọng bình luận tiếng Việt** và **nhạc nền**.

## 1. Cài đặt (1 lần)
1. Cài Node.js 18+ (https://nodejs.org)
2. Mở terminal trong thư mục này, chạy: `npm install`
3. Mở `config.json`, điền `"tiktokUsername": "ten_kenh_cua_ban"` (không cần @)

## 2. Chạy
- Chạy thật: `npm start`
- Thử không cần live (bot giả lập người chơi): `npm run demo`

Sau đó mở **Chrome**: `http://localhost:3000/` → bấm **▶ BẮT ĐẦU** (để bật âm thanh).
Bảng điều khiển (bỏ qua từ, ván mới, comment thử): `http://localhost:3000/panel`

## 3. Đưa lên TikTok Live
Overlay là khung dọc 9:16 (1080×1920), đã chừa chỗ cho khung chat phía dưới.
- **TikTok LIVE Studio / OBS**: thêm nguồn *Window Capture* (chụp cửa sổ Chrome đang mở overlay) hoặc *Browser Source* với URL trên, kích thước 1080×1920.
- ⚠ **Giọng đọc** dùng giọng tiếng Việt có sẵn của hệ điều hành/Chrome. *Browser Source* của OBS thường **không** có giọng đọc → hãy dùng Chrome + *Window Capture* và bật thu âm thanh cửa sổ (hoặc Desktop Audio).
- Tắt âm tạm: thêm `?nosound` sau URL.

## 4. Luật chơi (chỉnh trong `config.json`)
| Mục | Ý nghĩa |
|---|---|
| `dictionaryMode` | `loose`: từ trong `words.txt` **hoặc** 2 âm tiết hợp lệ · `strict`: chỉ từ trong từ điển |
| `blockDeadEnd` | `true`: chặn các từ cụt (nối vào là hết từ để nối tiếp, làm kẹt cả phòng) |
| `basePoints` / `comboBonus` | 100 điểm + 20/combo (tối đa +200) |
| `speedBonusSec` / `speedBonus` | trả lời trong 5 giây: +50 |
| `hintAfterSec` | sau 20s chưa ai đúng → hiện gợi ý chữ cái đầu |
| `skipAfterSec` | sau 60s → hệ thống tự nối giúp, reset combo |
| `music` | `enabled`, `volume` mặc định. Đổi bài / tải nhạc lên ngay ở trang `/panel` (mục 🎵 Nhạc nền) |
| `voice` | `enabled`, `rate` (tốc độ), `pitch` (cao độ) |

**Nhạc YouTube:** ở `/panel` → mục 🎵 Nhạc nền → dán link video hoặc playlist YouTube → *Thêm & phát*. Link được lưu lại để chọn lần sau. Nhạc phát bằng trình phát nhúng của YouTube trong trang overlay (cần có mạng và đã bấm BẮT ĐẦU). Video cấm nhúng sẽ tự chuyển về lo-fi và báo lỗi trên panel.

Chế độ `loose` vẫn kiểm tra từng chữ có đúng cấu tạo âm tiết tiếng Việt (nên "động aaa" không được tính). Từ điển hiện có hơn 1.200 từ.

Thêm từ vào `words.txt` (mỗi dòng 1 từ) để chuỗi nối dài và chính xác hơn. Bảng vàng lưu ở `leaderboard.json`.

## Ghi chú
- Giọng đọc & nhạc nền cần 1 lần click do trình duyệt chặn tự phát âm thanh.
- Thư viện `tiktok-live-connector` là bản không chính thức; nếu TikTok đổi API thì chạy `npm update tiktok-live-connector`.
- Overlay chỉ lắng nghe `127.0.0.1` (đổi `host` nếu cần truy cập từ máy khác).

---
## ☁ Chạy trên Render.com
1. Đưa thư mục này lên GitHub.
2. Render → **New → Blueprint** (dùng `render.yaml`) hoặc **New → Web Service**: Build `npm install`, Start `node server.js`.
3. Thêm biến môi trường `TIKTOK_USERNAME` = tên kênh TikTok (không có @).
4. Deploy xong: overlay ở `https://tên-của-bạn.onrender.com/`, điều khiển ở `/panel`.

**Chống tự tắt:** server tự gọi vào địa chỉ công khai của chính nó mỗi 4 phút (dùng biến `RENDER_EXTERNAL_URL` do Render cấp sẵn) nên gói Free không bị ngủ. Tắt bằng `KEEPALIVE=off`.
Bảng vàng và nhạc đã tải lên trên Render Free sẽ mất khi khởi động lại; muốn giữ, dùng gói trả phí + Disk và đặt `DATA_DIR=/data`.
