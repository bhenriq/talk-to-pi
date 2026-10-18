// keywatcher.m — macOS helper that prints physical key-state changes to stdout.
// Exit codes: 0 = running, 2 = bad usage.
//
// Build (done automatically by the extension when the binary is missing or stale):
//   clang -fobjc-arc -framework Foundation -framework CoreGraphics \
//         -framework ApplicationServices -o keywatcher keywatcher.m

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

int main(int argc, const char *argv[]) {
    if (argc < 3) {
        printf("usage: keywatcher <keycode> <pollMs>\n");
        return 2;
    }
    int keycode = (int)strtol(argv[1], NULL, 10);
    int pollMs = (int)strtol(argv[2], NULL, 10);
    if (pollMs < 5) pollMs = 5;

    @autoreleasepool {
        int last = -1;
        for (;;) {
            int down = CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, (CGKeyCode)keycode) ? 1 : 0;
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