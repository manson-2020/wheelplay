#pragma once
#include <chrono>
#include <thread>
#include <utility>

// Preserve every packet's result: a successful tail packet must not hide an earlier failure.
// Bursts at or above the threshold (an HEVC keyframe can span hundreds of packets) are paced
// so loss-prone hotspot buffers are not overwhelmed by a single access unit. The schedule is
// absolute-deadline based: a transport that is already slower than the interval skips waits.
namespace wheelplay {
inline constexpr size_t paceThresholdPackets = 48;
inline constexpr std::chrono::microseconds paceInterval{200};

template<class Messages, class Send> bool sendAll(Messages& messages, Send send) {
    bool success = !messages.empty();
    if (messages.size() < paceThresholdPackets) {
        for (auto& message : messages) success = send(std::move(message)) && success;
        return success;
    }
    auto deadline = std::chrono::steady_clock::now();
    for (auto& message : messages) {
        success = send(std::move(message)) && success;
        deadline += paceInterval;
        while (std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
    }
    return success;
}
}
