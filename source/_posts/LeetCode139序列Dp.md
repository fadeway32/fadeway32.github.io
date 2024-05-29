---
abbrlink: 1
---

# 序列Dp

平台：LeetCode

题号：139

给你一个字符串 `s` 和一个字符串列表 `wordDict` 作为字典。

请你判断是否可以利用字典中出现的单词拼接出 `s` 。

注意：不要求字典中出现的单词全部都使用，并且字典中的单词可以重复使用。

~~~html
输入: s = "leetcode", wordDict = ["leet", "code"]

输出: true

解释: 返回 true 因为 "leetcode" 可以由 "leet" 和 "code" 拼接成。
~~~

~~~html
输入: s = "applepenapple", wordDict = ["apple", "pen"]

输出: true

解释: 返回 true 因为 "applepenapple" 可以由 "apple" "pen" "apple" 拼接成。
注意，你可以重复使用字典中的单词。
~~~

~~~html
输入: s = "catsandog", wordDict = ["cats", "dog", "sand", "and", "cat"]

输出: false
~~~

提示：

-
-
-
- `s` 和 `wordDict[i]` 仅有小写英文字母组成
- `wordDict` 中的所有字符串 互不相同

解答：

~~~java
class Solution{
    
    
    public boolean getContainsResult(String s, String[] arrays){
        if(arrays == null || arrays.length == 0  ){
            return false;
        }
        Set<String> sets = new HashSet<>();
        for(String str: arrays){
            sets.add(str);
        }
        // 初始化数组
        int n = s.length() ;
        boolean[]  result = new boolean[n+10];
        result[0] = true;
        // 从1开始
        for(int i = 1;i <= n ;i++ ){
            for(int j=1;j <=i && !result[i];j++){
                String s = s.substring(j-1,i);
                if(sets.contains(s){
                    result[i] = result[j-1];
                }
                    
                
            }
            
        }
        return result[n];
        
           
        
        
    }
    
    
    
    
    
}
~~~

线性 DP 通常强调「状态转移所依赖的前驱状态」是由给定数组所提供的，即拓扑序是由原数组直接给出。更大白话来说就是通常有
依赖于 。

这就限定了线性 DP 的复杂度是简单由「状态数量（或者说是维度数）」所决定。

序列 DP
通常需要结合题意来寻找前驱状态，即需要自身寻找拓扑序关系（例如本题，需要自己通过枚举的方式来找左端点，从而找到可转移的前驱状态 ）。