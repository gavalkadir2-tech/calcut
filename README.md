# calcut

## Arka plan bildirimleri (uygulama kapalıyken mesaj ve arama alarmı) — ücretsiz

Uygulama kapalıyken (ya da telefon kilitliyken) yeni mesaj ve gelen arama
için "Alarm" görünümlü, sesli ve titreşimli bildirim gelir. Firebase'in
ücretsiz (Spark) planında çalışır; kredi kartı gerekmez.

- `worker/_worker.js`: Cloudflare'de (ücretsiz) çalışan küçük sunucu. Uygulama mesaj gönderince / arama başlatınca buna haber verir; Worker
  gönderenin gerçekten o kişi olduğunu Firestore'dan doğrulayıp alıcının
  cihazlarına Firebase Cloud Messaging (FCM) ile push gönderir.
- `sw.js`: Push'u alıp bildirimi gösterir. Arama çalarken 8 saniyede bir
  yeniden çalar, cevapsız kalırsa "Cevapsız" olur. Bildirime dokununca uygulama
  açılır; PIN girildikten sonra hâlâ çalan arama ekrana gelir (arama 45 sn çalar).

### Bir kerelik kurulum

1. **Web Push anahtarı** (yapıldı): `firebase-config.js` → `window.FCM_VAPID_KEY`.
2. **Servis hesabı anahtarı:** Firebase konsolu → Proje ayarları →
   *Hizmet hesapları (Service accounts)* → "Yeni özel anahtar oluştur" →
   bir `.json` dosyası iner. Bu dosya gizlidir, kimseyle paylaşma, GitHub'a koyma.
3. **Cloudflare Pages (bildirim sunucusu):** Bazı Türk internet sağlayıcıları
   `*.workers.dev` adreslerini engellediği için sunucu `*.pages.dev` üzerinde
   çalıştırılır. GitHub'a bağlı olduğu için kod güncellenince kendiliğinden yayınlanır.
   1. https://dash.cloudflare.com → *Workers & Pages* → *Create* → **Pages** sekmesi →
      *Import an existing Git repository* → `gavalkadir2-tech/calcut` → *Begin setup*.
   2. Project name: `calcut-bildirim` · Production branch: `main` ·
      Framework preset: *None* · Build command: **boş** ·
      Build output directory: **`worker`** → *Save and Deploy*.
   3. Proje → *Settings* → *Variables and Secrets* → *Add* → Tür: **Secret**,
      Ad: `SERVICE_ACCOUNT`, Değer: 2. adımda inen `.json` dosyasının tüm içeriği → *Save*.
   4. *Deployments* → en üstteki dağıtım → *⋯* → *Retry deployment* (secret'ın
      devreye girmesi için).
   5. Proje adresini (ör. `https://calcut-bildirim.pages.dev`) VPN'siz açınca
      `"method not allowed"` yazmalı. Bu adresi `firebase-config.js` içindeki
      `window.PUSH_URLS` listesinin başına ekle. Sadece kendi adreslerini ekle:
      uygulama bu adreslere kullanıcının giriş anahtarını gönderir.
4. **Firestore kuralı gerekmez:** Cihaz anahtarları (`users/{uid}.fcmTokens`)
   sunucu tarafından servis hesabıyla kaydedilir.
5. Siteyi her zamanki gibi HTTPS üzerinden yayınla.

### Telefonda

- **iPhone (iOS 16.4+):** Safari'de aç → Paylaş → *Ana Ekrana Ekle*. Uygulamayı
  ana ekrandaki ikondan aç, giriş yap → Ayarlar → *Bildirimleri Etkinleştir* →
  izin ver. (iOS'ta bildirim yalnızca ana ekrandan açılan uygulamada çalışır.)
- **Android (Chrome):** Menü → *Uygulamayı yükle / Ana ekrana ekle*, sonra aynı
  ayarı aç. Ses gelmezse: telefon Ayarlar → Uygulamalar → Chrome → Bildirimler
  (ses açık olsun) ve Pil → Chrome için kısıtlama olmasın.

Her cihazda bir kez "Bildirimleri Etkinleştir" demek yeterli; hesaptan çıkınca
o cihaz bildirim listesinden silinir.
