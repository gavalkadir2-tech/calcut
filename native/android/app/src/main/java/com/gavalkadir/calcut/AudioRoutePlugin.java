package com.gavalkadir.calcut;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Routes call audio between the earpiece and the loudspeaker. A web page
 * can't do this, which is why the app is wrapped natively at all.
 *
 * Android 12+ uses setCommunicationDevice(); older versions fall back to
 * setSpeakerphoneOn(). Both only take effect while the audio mode is
 * MODE_IN_COMMUNICATION, so startCall() switches to it and endCall()
 * restores whatever mode was active before.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private Integer savedMode = null;

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void startCall(PluginCall call) {
        AudioManager am = audio();
        if (savedMode == null) savedMode = am.getMode();
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        call.resolve(route(am, call.getBoolean("speaker", false)));
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        AudioManager am = audio();
        if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
            if (savedMode == null) savedMode = am.getMode();
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        }
        call.resolve(route(am, call.getBoolean("on", false)));
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        AudioManager am = audio();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice();
        } else {
            am.setSpeakerphoneOn(false);
        }
        am.setMode(savedMode != null ? savedMode : AudioManager.MODE_NORMAL);
        savedMode = null;
        // A call answered from the lock screen must not leave the app showing over it.
        if (getActivity() instanceof MainActivity) {
            MainActivity a = (MainActivity) getActivity();
            a.runOnUiThread(() -> a.setShowOverLockScreen(false));
        }
        call.resolve();
    }

    private JSObject route(AudioManager am, boolean speaker) {
        JSObject result = new JSObject();
        boolean ok;
        String device;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            int wanted = speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            AudioDeviceInfo target = null;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getType() == wanted) { target = d; break; }
            }
            ok = target != null && am.setCommunicationDevice(target);
            AudioDeviceInfo current = am.getCommunicationDevice();
            device = current == null ? "none" : typeName(current.getType());
        } else {
            am.setSpeakerphoneOn(speaker);
            ok = am.isSpeakerphoneOn() == speaker;
            device = am.isSpeakerphoneOn() ? "speaker" : "earpiece";
        }
        result.put("ok", ok);
        result.put("device", device);
        return result;
    }

    private static String typeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "earpiece";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "speaker";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "headset";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bluetooth";
            default: return "type-" + type;
        }
    }
}
