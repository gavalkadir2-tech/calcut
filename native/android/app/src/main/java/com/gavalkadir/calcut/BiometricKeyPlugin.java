package com.gavalkadir.calcut;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A secret that only a fingerprint can release. It is sealed with an AES key
 * kept in the Android Keystore that can only be used right after a strong
 * biometric check, and that Android destroys if fingerprints are added or
 * removed. The web side uses the secret as the inner layer of the vault
 * (see sealSession in app.js), so the PIN alone no longer opens the session.
 */
@CapacitorPlugin(name = "BiometricKey")
public class BiometricKeyPlugin extends Plugin {

    private static final String KEY_ALIAS = "calcut_vault_biometric";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(r);
    }

    /** Creates a fresh key and secret, sealing the secret after one fingerprint check. */
    @PluginMethod
    public void enroll(PluginCall call) {
        Cipher cipher;
        try {
            deleteKey();
            SecretKey key = createKey();
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (Exception e) {
            call.reject("Biyometrik anahtar oluşturulamadı: " + e.getMessage());
            return;
        }
        prompt(call, cipher, c -> {
            byte[] secret = new byte[32];
            new SecureRandom().nextBytes(secret);
            byte[] sealed = c.doFinal(secret);
            JSObject r = new JSObject();
            r.put("secret", b64(secret));
            r.put("sealed", b64(c.getIV()) + "." + b64(sealed));
            return r;
        });
    }

    /** Releases the secret sealed by enroll() after a fingerprint check. */
    @PluginMethod
    public void unlock(PluginCall call) {
        String sealed = call.getString("sealed", "");
        String[] parts = sealed.split("\\.");
        if (parts.length != 2) {
            call.reject("invalid sealed value");
            return;
        }
        Cipher cipher;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(KEY_ALIAS, null);
            if (key == null) {
                call.reject("Biyometrik anahtar yok", "invalidated");
                return;
            }
            cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, unb64(parts[0])));
        } catch (KeyPermanentlyInvalidatedException e) {
            // Fingerprints were added or removed since enrollment.
            call.reject("Parmak izi kayıtları değişti", "invalidated");
            return;
        } catch (Exception e) {
            call.reject("Biyometrik anahtar açılamadı: " + e.getMessage());
            return;
        }
        byte[] ciphertext = unb64(parts[1]);
        prompt(call, cipher, c -> {
            JSObject r = new JSObject();
            r.put("secret", b64(c.doFinal(ciphertext)));
            return r;
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            deleteKey();
        } catch (Exception ignored) {}
        call.resolve();
    }

    private interface CipherStep {
        JSObject run(Cipher cipher) throws Exception;
    }

    private void prompt(PluginCall call, Cipher cipher, CipherStep step) {
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        try {
                            call.resolve(step.run(result.getCryptoObject().getCipher()));
                        } catch (Exception e) {
                            call.reject("Biyometrik işlem başarısız: " + e.getMessage());
                        }
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                        call.reject(msg.toString(), "cancelled");
                    }
                });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Kimliğini doğrula")
                .setNegativeButtonText("İptal")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            bp.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private static SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Every use needs its own fingerprint check, and only a strong biometric counts.
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(spec.build());
        return kg.generateKey();
    }

    private static void deleteKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
    }

    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    private static byte[] unb64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }
}
