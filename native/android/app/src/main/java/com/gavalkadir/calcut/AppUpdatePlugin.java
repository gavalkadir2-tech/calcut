package com.gavalkadir.calcut;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The app is installed from an APK, not a store, so nothing updates it.
 * The web side compares this build's versionCode with the one the release
 * advertises and offers the download.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            JSObject r = new JSObject();
            r.put("versionCode", code);
            r.put("versionName", info.versionName);
            call.resolve(r);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject(e.getMessage());
        }
    }

    /** Opens a link from a message in the phone's browser, outside the app. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("invalid url");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Opens the APK link in the browser, which downloads it for the installer. */
    @PluginMethod
    public void openDownload(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://github.com/gavalkadir2-tech/calcut/releases/")) {
            call.reject("invalid url");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }
}
