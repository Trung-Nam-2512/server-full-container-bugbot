# Kế hoạch Tối ưu hóa API (Từ Polling sang Server-Sent Events - SSE)

Tài liệu này ghi chú lại vấn đề về hiệu năng và định hướng thiết kế để nâng cấp kiến trúc API giao tiếp giữa Frontend và Backend.

## 1. Phân tích Vấn đề Hiện tại (HTTP 429 Too Many Requests)

### Thực trạng thiết kế
Hiện tại, Frontend Dashboard đang sử dụng cơ chế **Polling (hỏi vòng)** để cập nhật dữ liệu liên tục từ Backend:
- Cập nhật Event Feed: 3 giây/lần
- Cập nhật Device Status/Table: 10 giây/lần
- Cập nhật Image Gallery: 60 giây/lần

### Nhược điểm và Tại sao bị lỗi
- **Dư thừa Request (Overhead):** Việc Frontend liên tục gửi HTTP GET requests (kể cả khi ESP32-CAM không gửi gì) tạo ra hàng loạt các request rỗng vô ích. 
- **Vi phạm Rate Limit:** Với số lượng polling quá dày, chỉ trong chưa tới vài phút treo máy, hệ thống sẽ gửi hơn 100 requests. Điều này vi phạm cấu hình phòng thủ DDoS (`EXPRESS_RATE_LIMIT`) mặc định trên Node.js, dẫn đến việc IP bị khóa tạm thời với lỗi **HTTP 429 Too Many Requests**.
- **Tiêu tốn tài nguyên Server:** Mỗi request đều bắt Backend phải mở TCP connection, xác thực CORS, đi qua Router và thực thi truy vấn Database dù kết quả trả về là không có gì mới. Nó làm lãng phí băng thông và tắc nghẽn tài nguyên trên Production. 

*(Cách khắc phục tạm thời hiện tại là tăng giới hạn Rate Limit (`RATE_LIMIT_MAX_REQUESTS`) trong file `docker-compose.prod.yml` từ `100` lên `2000`)*.

---

## 2. Giải pháp Tối ưu: Kiến trúc Server-Sent Events (SSE)

Bản chất của BugBot Dashboard là giám sát luồng sự kiện truyền đến (Stream-based) một chiều. Để giải quyết triệt để nút thắt cổ chai, giao thức WebSockets hoặc Server-Sent Events (SSE) cần được áp dụng. Ở đây, SSE được chọn là hướng đi tối ưu nhất vì cấu trúc cực kỳ gọn nhẹ và tương thích hoàn hảo với việc đẩy dữ liệu một chiều.

### Tại sao lại là SSE?
* Khác với WebSockets định tuyến 2 chiều phức tạp (chiếm dụng tài nguyên), SSE sử dụng kết nối HTTP(s) truyền thống thông thường.
* Client chỉ cần mở **1 kết nối HTTP duy nhất** đến Endpoint SSE của Express backend và cứ như vậy giữ trạng thái mở (`Keep-Alive`).
* Khi có sự kiện mới từ thiết bị IoT (MQTT Server bắt được), Backend Node.js sẽ chủ động "đẩy" đoạn text chứa event đó thẳng qua kênh kết nối đã mở. Frontend bắt sự kiện như một Web Event tiêu chuẩn (`onmessage`).
* Hạn chế tuyệt lượng lớn Request ảo. Tiết kiệm tới 99% HTTP Header traffic và bỏ qua hoàn toàn cơ chế Polling cũ kĩ.

---

## 3. Các bước Triển khai Đề xuất (Kế hoạch Nâng cấp)

### Bước 1: Nâng cấp Backend (Express.js)
1. Viết thêm một route mới (VD: `GET /api/iot/mqtt/events/stream`).
2. Trong controller của route này, cấu hình Header SSE:
   ```javascript
   res.writeHead(200, {
     'Content-Type': 'text/event-stream',
     'Cache-Control': 'no-cache',
     'Connection': 'keep-alive'
   });
   ```
3. Đăng ký một Event Listener với MQTT Service hiện tại. Khi `MqttEventProcessor` nhận message từ Broker/Kafka, nó emit event này.
4. Controller hứng event đó và ghi vào response: `res.write('data: ' + JSON.stringify(payload) + '\n\n');`

### Bước 2: Nâng cấp Frontend (React.js)
1. Gỡ bỏ (`clearInterval`) hoàn toàn các logic `setInterval` fetch API liên quan đến Device và Event trong `useEffect`.
2. Khởi tạo `EventSource` để lắng nghe từ Endpoint SSE:
   ```javascript
   const eventSource = new EventSource('/api/iot/mqtt/events/stream');
   eventSource.onmessage = (event) => {
       const newIoTData = JSON.parse(event.data);
       // Cập nhật state (ví dụ: setEvents, setDevices) một cách tự động
   };
   ```

### Bước 3: Cấu hình Hạ tầng mạng phụ trợ (Nginx Proxy)
Ở môi trường Production, Nginx cần phải được cầu hình thêm để không ngắt giữa chừng và không tạo bộ lồng buffer với tín hiệu Event-Stream:
```nginx
location /api/iot/mqtt/events/stream {
    proxy_pass http://127.0.0.1:1435;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

## Kết luận
Sau khi hoàn thành đợt refactor áp dụng SSE, hệ thống BugBot có khả năng chạy "thực thời gian" (Real-time) chính xác, loại bỏ triệt để lỗi DDoS/Rate-Limit-429 và cho phép máy chủ đáp ứng đồng thời cả nghìn máy khách giám sát liên tục mà không lo Crash nền tảng.
