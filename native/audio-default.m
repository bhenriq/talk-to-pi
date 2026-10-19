// audio-default.m — get/set the macOS default input/output audio device by name,
// and play a short audio file to a specific device (for private cues).
//
// Usage:
//   audio-default get  input|output          -> prints the current default device name
//   audio-default set  input|output <name>   -> sets the default device by name
//   audio-default play <device> <file> [vol] -> plays <file> to <device> (0..1 volume)
//
// Exit codes: 0 = ok, 1 = device not found or unknown argument.

#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

static AudioDeviceID *g_devs = NULL;
static UInt32 g_count = 0;

static NSString *deviceUID(AudioDeviceID d) {
    CFStringRef uid = NULL;
    UInt32 s = sizeof(uid);
    AudioObjectPropertyAddress a = { kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(d, &a, 0, NULL, &s, &uid) == noErr && uid) {
        return (__bridge_transfer NSString *)uid;
    }
    return nil;
}

static NSString *deviceName(AudioDeviceID d) {
    CFStringRef n = NULL;
    UInt32 s = sizeof(n);
    AudioObjectPropertyAddress a = { kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(d, &a, 0, NULL, &s, &n) == noErr && n) {
        return (__bridge_transfer NSString *)n;
    }
    return nil;
}

static BOOL hasStreams(AudioDeviceID d, BOOL isInput) {
    AudioObjectPropertyScope scope = isInput ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput;
    AudioObjectPropertyAddress a = { kAudioDevicePropertyStreams, scope, kAudioObjectPropertyElementMain };
    UInt32 sz = 0;
    return AudioObjectGetPropertyDataSize(d, &a, 0, NULL, &sz) == noErr && sz > 0;
}

static AudioDeviceID findByName(NSString *name, BOOL isInput) {
    AudioDeviceID fallback = kAudioObjectUnknown;
    for (UInt32 i = 0; i < g_count; i++) {
        NSString *n = deviceName(g_devs[i]);
        if (n && [n isEqualToString:name]) {
            // Prefer the side that actually has streams for the requested direction
            // (e.g. "OpenSwim Pro by Shokz" has separate input and output devices).
            if (hasStreams(g_devs[i], isInput)) return g_devs[i];
            if (fallback == kAudioObjectUnknown) fallback = g_devs[i];
        }
    }
    return fallback;
}

static AudioObjectPropertySelector selectorFor(NSString *type, BOOL isSystemOutput) {
    if ([type isEqualToString:@"input"]) return kAudioHardwarePropertyDefaultInputDevice;
    if (isSystemOutput) return kAudioHardwarePropertyDefaultSystemOutputDevice;
    return kAudioHardwarePropertyDefaultOutputDevice;
}

static int getDevice(NSString *type, BOOL isSystemOutput) {
    AudioDeviceID d = kAudioObjectUnknown;
    UInt32 s = sizeof(d);
    AudioObjectPropertyAddress a = { selectorFor(type, isSystemOutput), kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &s, &d) != noErr) return 1;
    NSString *n = deviceName(d);
    printf("%s\n", n ? n.UTF8String : "?");
    return n ? 0 : 1;
}

static int setDevice(NSString *type, NSString *name) {
    AudioDeviceID d = findByName(name, [type isEqualToString:@"input"]);
    if (d == kAudioObjectUnknown) {
        fprintf(stderr, "device not found: %s\n", name.UTF8String);
        return 1;
    }
    AudioObjectPropertySelector sel = selectorFor(type, NO);
    AudioObjectPropertyAddress a = { sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    OSStatus e = AudioObjectSetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, sizeof(d), &d);
    if (e != noErr) {
        fprintf(stderr, "failed to set %s to %s (err %d)\n", type.UTF8String, name.UTF8String, (int)e);
        return 1;
    }
    if ([type isEqualToString:@"output"]) {
        // Also move the "system output" (alerts / sound effects) as most apps follow it.
        AudioObjectPropertyAddress sa = { kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        AudioObjectSetPropertyData(kAudioObjectSystemObject, &sa, 0, NULL, sizeof(d), &d);
    }
    return 0;
}

static int playSound(NSString *name, NSString *path, double volume) {
    AudioDeviceID d = findByName(name, NO);
    if (d == kAudioObjectUnknown) {
        fprintf(stderr, "device not found: %s\n", name.UTF8String);
        return 1;
    }
    NSString *uid = deviceUID(d);
    if (!uid) {
        fprintf(stderr, "no UID for device %s\n", name.UTF8String);
        return 1;
    }
    NSSound *sound = [[NSSound alloc] initWithContentsOfFile:path byReference:NO];
    if (!sound) {
        fprintf(stderr, "could not load audio file: %s\n", path.UTF8String);
        return 1;
    }
    [sound setPlaybackDeviceIdentifier:uid];
    if (volume >= 0) [sound setVolume:volume];
    [sound play];
    while ([sound isPlaying]) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: audio-default get|set input|output [device-name]  |  play <device> <file> [volume]\n");
            return 1;
        }
        AudioObjectPropertyAddress a = { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        UInt32 sz = 0;
        AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &sz);
        g_count = sz / sizeof(AudioDeviceID);
        g_devs = malloc(sz);
        AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &sz, g_devs);

        NSString *cmd = [NSString stringWithUTF8String:argv[1]];
        if ([cmd isEqualToString:@"play"]) {
            if (argc < 4) {
                fprintf(stderr, "usage: audio-default play <device> <file> [volume]\n");
                free(g_devs);
                return 1;
            }
            NSString *device = [NSString stringWithUTF8String:argv[2]];
            NSString *path = [NSString stringWithUTF8String:argv[3]];
            double vol = argc >= 5 ? atof(argv[4]) : 1.0;
            int rc = playSound(device, path, vol);
            free(g_devs);
            return rc;
        }
        if (argc < 3) {
            fprintf(stderr, "usage: audio-default get|set input|output [device-name]\n");
            free(g_devs);
            return 1;
        }
        NSString *type = [NSString stringWithUTF8String:argv[2]];
        if (![type isEqualToString:@"input"] && ![type isEqualToString:@"output"]) {
            fprintf(stderr, "type must be input or output\n");
            free(g_devs);
            return 1;
        }
        int rc;
        if ([cmd isEqualToString:@"get"]) {
            rc = getDevice(type, NO);
        } else if ([cmd isEqualToString:@"set"] && argc >= 4) {
            rc = setDevice(type, [NSString stringWithUTF8String:argv[3]]);
        } else {
            fprintf(stderr, "usage: audio-default get|set input|output [device-name]\n");
            rc = 1;
        }
        free(g_devs);
        return rc;
    }
}