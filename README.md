# calcut

## Arka plan bildirimleri (uygulama kapalıyken sesli bildirim)

Uygulama bir PWA'dır: ana ekrana eklendiğinde Service Worker (`sw.js`) üzerinden,
tarayıcı kapalıyken de Firebase Cloud Messaging (FCM) ile bildirim alır.
Mesaj geldiğinde `functions/index.js` içindeki Cloud Function alıcının cihazlarına push gönderir.

### Bir kerelik kurulum

1. **VAPID anahtarı:** Firebase konsolu → Proje ayarları → Cloud Messaging →
   *Web Push sertifikaları* → "Generate key pair". Çıkan anahtarı
   `firebase-config.js` içindeki `window.FCM_VAPID_KEY` alanına yapıştır.
2. **Blaze planı:** Cloud Functions için Firebase projesinin Blaze (kullandıkça öde)
   planında olması gerekir (bu kullanımda ücretsiz kota yeterlidir).
3. **Fonksiyonu yükle:**
   ```
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
   Firestore veritabanın `eur3` bölgesindeyse `functions/index.js` içindeki
   `region` değerini `europe-west1` yap.
4. Siteyi **HTTPS** üzerinden yayınla (GitHub Pages / Firebase Hosting olur).

### Telefonda

- **iPhone (iOS 16.4+):** Safari'de aç → Paylaş → *Ana Ekrana Ekle*. Uygulamayı
  ana ekrandaki ikondan aç, giriş yap → Ayarlar → *Arka plan bildirimlerini aç*.
  (iOS'ta bildirim yalnızca ana ekrana eklenmiş uygulamada çalışır.)
- **Android (Chrome):** Menü → *Ana ekrana ekle / Uygulamayı yükle*, ardından
  Ayarlar → *Arka plan bildirimlerini aç*. Ses gelmiyorsa telefon Ayarlar →
  Uygulamalar → Chrome → Bildirimler kısmında sesin açık olduğunu ve
  pil optimizasyonunun Chrome'u kısıtlamadığını kontrol et.

Bildirim metni gizlilik için genel tutulur ("Hesap Makinesi – Yeni bir bildirimin var");
mesaj içerikleri uçtan uca şifreli olduğu için sunucu zaten okuyamaz.
