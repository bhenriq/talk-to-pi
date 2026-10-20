// keywatcher.m — macOS helper that prints physical key-state changes to stdout.
// Exit codes: 0 = running, 2 = bad usage.
//
// Build (done automatically by the extension when the binary is missing or stale):
//   clang -fobjc-arc -framework Foundation -framework CoreGraphics \
//         -framework ApplicationServices -framework AppKit -o keywatcher keywatcher.m
//
// usage: keywatcher <keycode> <pollMs> [bundleIds]
//   bundleIds: optional comma-separated list of frontmost-app bundle identifiers.
//   When provided, the key is only reported "down" while one of those apps is
//   frontmost, so holding the talk key in another app never starts a recording.

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
    if (argc < 3) {
        printf("usage: keywatcher <keycode> <pollMs> [bundleIds]\n");
        return 2;
    }
    int keycode = (int)strtol(argv[1], NULL, 10);
    int pollMs = (int)strtol(argv[2], NULL, 10);
    if (pollMs < 5) pollMs = 5;

    NSArray<NSString *> *allowed = nil;
    if (argc >= 4) {
        NSString *s = [NSString stringWithUTF8String:argv[3]];
        allowed = [s componentsSeparatedByString:@","];
        if (allowed.count == 0 || (allowed.count == 1 && allowed.firstObject.length == 0)) allowed = nil;
    }

    @autoreleasepool {
        int last = -1;
        for (;;) {
            BOOL keyDown = CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, (CGKeyCode)keycode);
            BOOL frontmostAllowed = YES;
            if (allowed) {
                NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
                NSString *bid = front.bundleIdentifier ?: @"";
                frontmostAllowed = [allowed containsObject:bid];
            }
            int down = (keyDown && frontmostAllowed) ? 1 : 0;
            if (down != last) {
                printf("%d\n", down);
                fflush(stdout);
                last = down;
            }
            usleep((useconds_t)pollMs * 1000);
        }
    }
    return 0;
}